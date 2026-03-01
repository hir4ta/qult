package hookhandler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/coach"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

type postToolUseInput struct {
	CommonInput
	ToolName     string          `json:"tool_name"`
	ToolInput    json.RawMessage `json:"tool_input"`
	ToolResponse json.RawMessage `json:"tool_response"`
	ToolUseID    string          `json:"tool_use_id"`
}

// Write tools that indicate file modification.
var writeTools = map[string]bool{
	"Write": true, "Edit": true, "NotebookEdit": true,
}

func handlePostToolUse(input []byte) (*HookOutput, error) {
	var in postToolUseInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] PostToolUse: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	// Lightweight mode: skip all analysis for agent sessions.
	// Agent sessions have their own sessiondb and don't benefit from monitoring.
	if isAgent, _ := sdb.GetContext("is_agent_session"); isAgent == "true" {
		return nil, nil
	}

	// Open buddy.db for direct knowledge writes (phases, files, sequences).
	// Nil-safe: callers check st != nil before use.
	st, _ := store.OpenDefaultCached()

	// Cache task_type and velocity for contextual Thompson Sampling.
	SetDeliveryContext(sdb)

	isWrite := writeTools[in.ToolName]
	inputHash := hashInput(in.ToolName, in.ToolInput)

	// Verify pending resolution from previous tool call (success path).
	verifyPendingResolution(sdb, true)

	// Check nudge timeout: 4+ tools without resolution → negative signal.
	checkNudgeTimeout(sdb)

	// Check if this action resolves a previously delivered nudge or LLM suggestion.
	checkNudgeResolution(sdb, in.ToolName)
	checkLLMSuggestionResolution(sdb, in.ToolName)
	checkSignalResolution(sdb, in.ToolName)

	if err := sdb.RecordEvent(in.ToolName, inputHash, isWrite); err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] PostToolUse: record event: %v\n", err)
		return nil, nil
	}

	// Track file reads for Read, Grep, Glob.
	// Also record file last read sequence for stale-read detection.
	switch in.ToolName {
	case "Read":
		var ri struct {
			FilePath string `json:"file_path"`
		}
		if json.Unmarshal(in.ToolInput, &ri) == nil && ri.FilePath != "" {
			_ = sdb.IncrementFileRead(ri.FilePath)
			if seq, err := sdb.CurrentEventSeq(); err == nil {
				_ = sdb.RecordFileLastRead(ri.FilePath, seq)
			}
		}
	case "Grep":
		var gi struct {
			Path string `json:"path"`
		}
		if json.Unmarshal(in.ToolInput, &gi) == nil && gi.Path != "" {
			_ = sdb.IncrementFileRead(gi.Path)
		}
	}

	// Update session context for mode tracking.
	switch in.ToolName {
	case "EnterPlanMode":
		_ = sdb.SetContext("plan_mode", "active")
	case "ExitPlanMode":
		_ = sdb.SetContext("plan_mode", "")
	case "Task":
		_ = sdb.SetContext("subagent_active", "true")
	case "AskUserQuestion":
		_ = sdb.SetContext("awaiting_question_followup", "true")
	}

	// Track test and build command execution for workflow guidance.
	if in.ToolName == "Bash" {
		var bi struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(in.ToolInput, &bi) == nil {
			resp := string(in.ToolResponse)

			// Use command-specific detection instead of generic containsError.
			// Generic detection produces false positives from log messages
			// (e.g., buddy seed pattern logs containing "undefined" or "error").
			if testCmdPattern.MatchString(bi.Command) {
				_ = sdb.SetContext("has_test_run", "true")

				testFailed := isGoTestFailure(resp)
				prevTestPassed, _ := sdb.GetContext("last_test_passed")
				if testFailed {
					_ = sdb.SetContext("last_test_passed", "false")
					if prevTestPassed == "true" {
						ctxJSON, _ := json.Marshal(map[string]string{"tool": "Bash", "cmd": truncate(bi.Command, 120)})
						_ = sdb.RecordStructuredEvent("error", "test regression: previously passing tests now fail", string(ctxJSON))
					}
				} else {
					_ = sdb.SetContext("last_test_passed", "true")
					if prevTestPassed == "false" {
						ctxJSON, _ := json.Marshal(map[string]string{"tool": "Bash", "cmd": truncate(bi.Command, 120)})
						_ = sdb.RecordStructuredEvent("fix", "tests now passing after previous failure", string(ctxJSON))
					}
				}

				}

			// Track build/compile success with precise detection.
			if isCompileCommand(bi.Command) {
				if isBuildFailure(resp) {
					_ = sdb.SetContext("last_build_passed", "false")
				} else {
					_ = sdb.SetContext("last_build_passed", "true")
				}
			}
		}
	}

	// Lightweight mode: skip heavy analysis during subagent activity.
	// Basic event recording, file tracking, and context tracking above are retained.
	if sdb.ActiveSubagentCount() > 0 {
		return nil, nil
	}

	// Update EWMA flow metrics (velocity, error rate).
	updateFlowMetrics(sdb, false)

	// Track success streak for FlowState classification.
	streak := getInt(sdb, "success_streak")
	_ = sdb.SetContext("success_streak", strconv.Itoa(streak+1))

	// Record health snapshot every 10 tool calls for trend prediction.
	recordHealthSnapshot(sdb)

	// Wall detection: clear flag (data only, no output).
	if IsWallDetected(sdb) {
		ClearWallDetected(sdb)
	}

	// Record workflow phase for adaptive learning.
	recordPhase(sdb, in.ToolName, in.ToolInput)

	// Persist phase to buddy.db for cross-session learning.
	if st != nil {
		if phase := classifyPhase(in.ToolName, in.ToolInput); phase != "" {
			_ = st.RecordLivePhase(in.SessionID, phase, in.ToolName)
		}
	}

	// Workflow alignment: record data only (no output).
	_ = updateWorkflowAlignment(sdb)

	// Record tool outcome for prediction intelligence.
	filePath := extractFilePath(in.ToolInput)
	_ = sdb.RecordToolOutcome(in.ToolName, filePath, true) // success path

	// Record tool sequence for bigram prediction.
	prevTool, _ := sdb.GetContext("prev_tool")
	if prevTool != "" {
		_ = sdb.RecordSequence(prevTool, in.ToolName, "success")
		if st != nil {
			_ = st.IncrementToolSequence(prevTool, in.ToolName)
		}
	}

	// Record trigram for 3-tool sequence prediction.
	prevPrevTool, _ := sdb.GetContext("prev_prev_tool")
	if prevPrevTool != "" && prevTool != "" {
		_ = sdb.RecordTrigram(prevPrevTool, prevTool, in.ToolName, "success")
		if st != nil {
			_ = st.IncrementToolTrigram(prevPrevTool, prevTool, in.ToolName)
		}
	}
	_ = sdb.SetContext("prev_prev_tool", prevTool)
	_ = sdb.SetContext("prev_tool", in.ToolName)

	// Track files being edited in working set.
	if isWrite {
		if filePath != "" {
			_ = sdb.AddWorkingSetFile(filePath)
			if st != nil {
				_ = st.RecordLiveFile(in.SessionID, filePath)
				// Incremental co-change: record pairs with all files already in this session.
				if files, ferr := st.LiveSessionFiles(in.SessionID); ferr == nil && len(files) >= 2 {
					_ = st.RecordCoChanges(files)
				}
			}
			// Record structured event for LLM extraction.
			summary := fmt.Sprintf("%s %s", in.ToolName, filepath.Base(filePath))
			ctxJSON, _ := json.Marshal(map[string]string{"tool": in.ToolName, "file": filePath})
			_ = sdb.RecordStructuredEvent("decision", summary, string(ctxJSON))
		}
	}

	// Failure→solution pipeline: record fix when Edit/Write succeeds after a failure.
	if isWrite && filePath != "" {
		recordFailureSolution(sdb, in.SessionID, filePath, in.ToolInput)
	}

	// Solution chain tracking: append tool to chain sequence and finalize on success.
	trackSolutionChain(sdb, in.SessionID, in.ToolName, isWrite && filePath != "")

	// File change tracking for oscillation/revert detection.
	if isWrite && filePath != "" {
		trackFileChange(sdb, filePath, in.CWD)
	}

	// External linter checks on write operations.
	if isWrite && filePath != "" {
		lintAfterWrite(sdb, filePath, in.CWD)
	}

	// Run lightweight signal detection (data recording only, no output).
	det := &HookDetector{sdb: sdb}
	det.Detect()

	// Search for past error solutions when Bash fails.
	// Also record the failure for PreToolUse past-failure warning.
	if in.ToolName == "Bash" && len(in.ToolResponse) > 0 {
		resp := string(in.ToolResponse)
		var bi struct {
			Command string `json:"command"`
		}
		_ = json.Unmarshal(in.ToolInput, &bi)

		if containsError(resp) {
			if bi.Command != "" {
				sig := extractCmdSignature(bi.Command)
				errSummary := extractErrorSignature(resp)
				if sig != "" {
					_ = sdb.RecordBashFailure(sig, errSummary)
				}
				// Record structured event for LLM extraction.
				if errSummary != "" {
					ctxJSON, _ := json.Marshal(map[string]string{"tool": "Bash", "cmd": truncate(bi.Command, 120)})
					_ = sdb.RecordStructuredEvent("error", errSummary, string(ctxJSON))
				}
			}
			matchPastErrorSolutions(sdb, resp)
		}

		// Test failure: synchronous feedback with correlation + past solutions + re-run command.
		if bi.Command != "" && testCmdPattern.MatchString(bi.Command) && containsError(resp) {
			if msg := buildTestFailureGuidance(sdb, in.SessionID, bi.Command, resp, in.CWD); msg != "" {
				return makeOutput("PostToolUse", msg), nil
			}
		}
	}

	// Enrich MCP tool output with session context for buddy tools.
	if strings.HasPrefix(in.ToolName, "mcp__claude-buddy__") {
		if enrichment := buildMCPEnrichment(sdb); enrichment != "" {
			return &HookOutput{
				HookSpecificOutput: map[string]any{
					"hookEventName":         "PostToolUse",
					"updatedMCPToolOutput":  string(in.ToolResponse) + "\n\n" + enrichment,
				},
			}, nil
		}
	}

	return nil, nil
}

// buildMCPEnrichment builds session context to append to MCP tool output.
func buildMCPEnrichment(sdb *sessiondb.SessionDB) string {
	var parts []string

	if intent, _ := sdb.GetWorkingSet("intent"); intent != "" {
		parts = append(parts, "Current task: "+intent)
	}
	if taskType, _ := sdb.GetContext("task_type"); taskType != "" {
		parts = append(parts, "Task type: "+taskType)
	}
	if branch, _ := sdb.GetWorkingSet("git_branch"); branch != "" {
		parts = append(parts, "Branch: "+branch)
	}
	tc, _, _, _ := sdb.BurstState()
	if tc > 0 {
		parts = append(parts, fmt.Sprintf("Tool calls this burst: %d", tc))
	}

	if len(parts) == 0 {
		return ""
	}
	return "[buddy session context] " + strings.Join(parts, " | ")
}

// checkPeriodicHealth enqueues a health checkpoint nudge every 20 tool calls.
// This replaces the buddy-checkpoint skill logic with hook-driven intelligence.
func checkPeriodicHealth(sdb *sessiondb.SessionDB) {
	tc, _, _, _ := sdb.BurstState()
	if tc == 0 || tc%20 != 0 {
		return
	}

	on, _ := sdb.IsOnCooldown("periodic_health")
	if on {
		return
	}
	_ = sdb.SetCooldown("periodic_health", 10*time.Minute)

	// Check for unresolved failures.
	failures, _ := sdb.RecentFailures(3)
	unresolvedCount := 0
	for _, f := range failures {
		if time.Since(f.Timestamp) > 10*time.Minute {
			continue
		}
		if f.FilePath == "" {
			continue
		}
		unresolved, _, _ := sdb.HasUnresolvedFailure(f.FilePath)
		if unresolved {
			unresolvedCount++
		}
	}

	if unresolvedCount > 0 {
		Deliver(sdb, "checkpoint", "info",
			fmt.Sprintf("Session checkpoint at %d tool calls", tc),
			fmt.Sprintf("%d unresolved failure(s) detected. Consider fixing before continuing.", unresolvedCount),
			PriorityMedium,
			"Unresolved failures can compound — each new edit may mask or worsen the original issue.")
		return
	}

	// Check if tests need running.
	hasTestRun, _ := sdb.GetContext("has_test_run")
	files, _ := sdb.GetWorkingSetFiles()
	if hasTestRun != "true" && len(files) > 3 {
		Deliver(sdb, "checkpoint", "info",
			fmt.Sprintf("Session checkpoint at %d tool calls", tc),
			fmt.Sprintf("%d files modified but tests not yet run. Consider running tests.", len(files)),
			PriorityMedium,
			"The longer you go without testing, the harder it is to isolate which change broke something.")
	}

	// Anomaly detection: explore/debug spiral.
	if alert := checkAnomaly(sdb); alert != "" {
		Deliver(sdb, "anomaly", "warning", "Behavioral pattern detected", alert, PriorityHigh,
			"Anomalous behavioral patterns correlate with declining session outcomes — early intervention saves time.")
	}

	// Health trend prediction: warn if declining toward threshold.
	if trend := PredictHealthTrend(sdb); trend != nil && trend.Trend == "declining" && trend.ToolsToThreshold > 0 {
		set, _ := sdb.TrySetCooldown("health_trend_warn", 15*time.Minute)
		if set {
			Deliver(sdb, "health-trend", "warning",
				fmt.Sprintf("Session health declining (%.0f%%)", trend.CurrentHealth*100),
				fmt.Sprintf("At current pace, health will drop below 50%% in ~%d tool calls. Consider taking a step back, running tests, or breaking the task into smaller steps.", trend.ToolsToThreshold),
				PriorityHigh,
				"Declining health correlates with increasing rework; pausing now saves more time than continuing.")
		}
	}
}

// checkWorkflowForCurrentTask checks workflow order based on stored task type.
func checkWorkflowForCurrentTask(sdb *sessiondb.SessionDB) string {
	taskTypeStr, _ := sdb.GetContext("task_type")
	if taskTypeStr == "" {
		return ""
	}

	on, _ := sdb.IsOnCooldown("workflow_nudge")
	if on {
		return ""
	}

	_, hasWrite, _, _ := sdb.BurstState()
	hasTestRun, _ := sdb.GetContext("has_test_run")
	planMode, _ := sdb.GetContext("plan_mode")

	suggestion := checkWorkflowOrder(
		TaskType(taskTypeStr), hasWrite,
		hasTestRun == "true",
		planMode == "active",
	)
	if suggestion == "" {
		return ""
	}

	_ = sdb.SetCooldown("workflow_nudge", 10*time.Minute)
	return suggestion
}

// matchFileContextKnowledge searches for patterns related to a file path.
func matchFileContextKnowledge(sdb *sessiondb.SessionDB, filePath string) {
	key := "file_knowledge:" + filepath.Base(filePath)
	on, _ := sdb.IsOnCooldown(key)
	if on {
		return
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	patterns, _ := st.SearchPatternsByFile(filePath, 2)
	if len(patterns) == 0 {
		return
	}

	_ = sdb.SetCooldown(key, 10*time.Minute)

	msg := "Related knowledge for this file:"
	for _, p := range patterns {
		content := p.Content
		if len([]rune(content)) > 100 {
			content = string([]rune(content)[:100]) + "..."
		}
		msg += fmt.Sprintf("\n  [%s] %s", p.PatternType, content)
	}

	Deliver(sdb, "file-knowledge", "info",
		fmt.Sprintf("Past knowledge found for %s", filepath.Base(filePath)),
		msg, PriorityLow)
}

// matchPastErrorSolutions checks Bash output for errors and searches past solutions.
func matchPastErrorSolutions(sdb *sessiondb.SessionDB, response string) {
	if !containsError(response) {
		return
	}

	on, _ := sdb.IsOnCooldown("past_solution")
	if on {
		return
	}

	sig := extractErrorSignature(response)
	solutions := searchErrorSolutions(sdb, sig)
	if len(solutions) == 0 {
		return
	}

	Deliver(sdb, "past-solution", "info",
		"Similar error found in past sessions",
		formatSolution(solutions[0]), PriorityMedium,
		"Past solutions for the same error signature succeeded before — applying them first is faster than debugging from scratch.")
	_ = sdb.SetCooldown("past_solution", 5*time.Minute)
}

// recordFailureSolution checks if a recent failure exists for this file and records
// the current successful edit as a solution.
func recordFailureSolution(sdb *sessiondb.SessionDB, sessionID, filePath string, toolInput json.RawMessage) {
	failures, _ := sdb.RecentFailuresForFile(filePath, 1)
	if len(failures) == 0 {
		return
	}
	f := failures[0]
	if time.Since(f.Timestamp) > 15*time.Minute {
		return
	}

	// Build solution description from the successful edit.
	var solution string
	var resolutionDiff string
	var edit struct {
		OldString string `json:"old_string"`
		NewString string `json:"new_string"`
	}
	if json.Unmarshal(toolInput, &edit) == nil && edit.NewString != "" {
		solution = fmt.Sprintf("Fixed %s by editing %s", f.FailureType, filepath.Base(filePath))
		if len([]rune(edit.NewString)) <= 200 {
			solution += fmt.Sprintf(": %s", edit.NewString)
		}
		// Store the exact resolution diff for future replay.
		if len([]rune(edit.OldString)) <= 500 && len([]rune(edit.NewString)) <= 500 {
			diffJSON, _ := json.Marshal(map[string]string{
				"old": edit.OldString, "new": edit.NewString,
			})
			resolutionDiff = string(diffJSON)
		}
	} else {
		solution = fmt.Sprintf("Fixed %s by rewriting %s", f.FailureType, filepath.Base(filePath))
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	if resolutionDiff != "" {
		_ = st.InsertFailureSolutionWithDiff(sessionID, f.FailureType, f.ErrorSig, filePath, solution, resolutionDiff, "")
	} else {
		_ = st.InsertFailureSolution(sessionID, f.FailureType, f.ErrorSig, filePath, solution)
	}

	// If a past solution was surfaced before this fix, mark it as effective.
	if idStr, _ := sdb.GetContext("last_surfaced_solution_id"); idStr != "" {
		var solutionID int
		if _, err := fmt.Sscanf(idStr, "%d", &solutionID); err == nil && solutionID > 0 {
			_ = st.IncrementTimesEffective(solutionID)
		}
		_ = sdb.SetContext("last_surfaced_solution_id", "")
	}
}

// classifyPhase maps a tool call to a workflow phase string.
// Returns "" if the tool doesn't map to a recognized phase.
func classifyPhase(toolName string, toolInput json.RawMessage) string {
	switch toolName {
	case "Read", "Grep", "Glob":
		return "read"
	case "Edit", "Write", "NotebookEdit":
		return "write"
	case "EnterPlanMode":
		return "plan"
	case "Bash":
		var bi struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(toolInput, &bi) == nil && bi.Command != "" {
			if testCmdPattern.MatchString(bi.Command) {
				return "test"
			}
			if isCompileCommand(bi.Command) {
				return "compile"
			}
		}
	}
	return ""
}

// recordPhase maps a tool call to a workflow phase and records it in sessiondb.
// It also detects phase transitions and sets the at_workflow_boundary flag.
func recordPhase(sdb *sessiondb.SessionDB, toolName string, toolInput json.RawMessage) {
	// Detect workflow boundaries from task/git events.
	switch toolName {
	case "Bash":
		var bi struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(toolInput, &bi) == nil && isGitCommitCommand(bi.Command) {
			_ = sdb.SetContext("at_workflow_boundary", "true")
		}
	case "TaskCreate", "TaskUpdate":
		_ = sdb.SetContext("at_workflow_boundary", "true")
	}

	phase := classifyPhase(toolName, toolInput)
	if phase == "" {
		return
	}

	// Detect phase transition: compare with previous recorded phase.
	prevPhase, _ := sdb.GetContext("prev_phase")
	if prevPhase != "" && prevPhase != phase {
		_ = sdb.SetContext("at_workflow_boundary", "true")
		_ = sdb.SetContext("coaching_phase_changed", "true")
	}
	_ = sdb.SetContext("prev_phase", phase)

	_ = sdb.RecordPhase(phase, toolName)
}

// isGitCommitCommand detects git commit commands in Bash input.
func isGitCommitCommand(cmd string) bool {
	return strings.Contains(cmd, "git commit") || strings.Contains(cmd, "git merge")
}

// trackSolutionChain appends the current tool to the active chain sequence.
// When a write succeeds (potential fix), the chain is finalized and persisted.
func trackSolutionChain(sdb *sessiondb.SessionDB, sessionID, toolName string, isSuccessfulWrite bool) {
	chainSig, _ := sdb.GetContext("chain_failure_sig")
	if chainSig == "" {
		return
	}

	// Append tool to sequence.
	seq, _ := sdb.GetContext("chain_tool_seq")
	if seq != "" {
		seq += "," + toolName
	} else {
		seq = toolName
	}
	_ = sdb.SetContext("chain_tool_seq", seq)

	stepStr, _ := sdb.GetContext("chain_step_count")
	step := 0
	if stepStr != "" {
		fmt.Sscanf(stepStr, "%d", &step)
	}
	step++
	_ = sdb.SetContext("chain_step_count", fmt.Sprintf("%d", step))

	// Finalize chain when a write succeeds (likely fix) or after 20 steps (abandon).
	if isSuccessfulWrite || step >= 20 {
		if step >= 2 && step < 20 {
			// Persist to store as a reusable playbook.
			toolSeqJSON, _ := json.Marshal(strings.Split(seq, ","))
			st, err := store.OpenDefaultCached()
			if err == nil {
				_ = st.InsertSolutionChain(sessionID, chainSig, string(toolSeqJSON), step)
			}
		}
		// Clear chain state.
		_ = sdb.SetContext("chain_failure_sig", "")
		_ = sdb.SetContext("chain_tool_seq", "")
		_ = sdb.SetContext("chain_step_count", "")
	}
}

// suggestTestForEdit uses the coverage map and function change detection
// to suggest a specific `go test -run` command after editing a Go file.
func suggestTestForEdit(sdb *sessiondb.SessionDB, filePath string, toolInput json.RawMessage, cwd string) {
	cooldownKey := "test_suggest:" + filepath.Base(filePath)
	on, _ := sdb.IsOnCooldown(cooldownKey)
	if on {
		return
	}

	// Detect which functions were changed.
	editSnippet := extractWriteContent(toolInput)
	var fullContent []byte
	if data, err := os.ReadFile(filePath); err == nil {
		fullContent = data
	}
	changedFuncs := DetectChangedGoFunctions(filePath, fullContent, editSnippet)
	if len(changedFuncs) == 0 {
		return
	}

	// Try coverage map for specific test command.
	cm := LoadCoverageMap(sdb)
	cmd := SuggestTestCommand(cm, filePath, changedFuncs, cwd)
	if cmd == "" {
		return
	}

	_ = sdb.SetCooldown(cooldownKey, 10*time.Minute)
	Deliver(sdb, "test-suggest", "info",
		fmt.Sprintf("Changed functions: %s", strings.Join(changedFuncs, ", ")),
		fmt.Sprintf("Run: %s", cmd),
		PriorityMedium,
		"Running targeted tests for changed functions catches regressions without the overhead of the full test suite.")
}

// buildTestFailureGuidance builds a synchronous context message when tests fail.
// Combines: (1) test-to-edit correlation, (2) past resolution chains, (3) specific re-run command.
func buildTestFailureGuidance(sdb *sessiondb.SessionDB, sessionID, cmd, resp, cwd string) string {
	var b strings.Builder
	b.WriteString("[buddy] TEST FAILURE — fix before continuing:")

	// 1. Correlate failures with recent edits.
	failures := extractTestFailures(resp)
	if correlation := correlateWithRecentEdits(sdb, failures); correlation != "" {
		fmt.Fprintf(&b, "\n  Correlation: %s", correlation)
	}

	// 2. Search past resolution chains for this failure signature.
	errSig := extractErrorSignature(resp)
	if errSig != "" {
		st, err := store.OpenDefaultCached()
		if err == nil {
			chains, _ := st.SearchSolutionChains("test:"+errSig, 1)
			if len(chains) > 0 {
				fmt.Fprintf(&b, "\n  Past fix (%d steps): %s", chains[0].StepCount, chains[0].ToolSequence)
			}
			solutions, _ := st.SearchFailureSolutionsWithDiff("test", errSig, 1)
			if len(solutions) > 0 && solutions[0].ResolutionDiff != "" {
				var diff struct {
					Old string `json:"old"`
					New string `json:"new"`
				}
				if json.Unmarshal([]byte(solutions[0].ResolutionDiff), &diff) == nil && diff.Old != "" {
					old := truncate(diff.Old, 60)
					new_ := truncate(diff.New, 60)
					fmt.Fprintf(&b, "\n  Previous fix: `%s` → `%s`", old, new_)
				}
			}
		}
	}

	// 3. Suggest specific re-run command.
	if len(failures) > 0 {
		var names []string
		for _, f := range failures {
			if f.TestName != "" && len(names) < 5 {
				names = append(names, f.TestName)
			}
		}
		if len(names) > 0 {
			fmt.Fprintf(&b, "\n  Re-run: go test -run '%s' -count=1 -v", strings.Join(names, "|"))
			// Extract package from the original command if possible.
			if pkg := extractTestPackage(cmd); pkg != "" {
				fmt.Fprintf(&b, " %s", pkg)
			}
		}
	} else {
		// No parsed failures — suggest re-running the same command.
		fmt.Fprintf(&b, "\n  Re-run: %s", cmd)
	}

	// Start solution chain tracking for this failure.
	if errSig != "" {
		_ = sdb.SetContext("chain_failure_sig", "test:"+errSig)
		_ = sdb.SetContext("chain_tool_seq", "")
		_ = sdb.SetContext("chain_step_count", "0")
	}

	return b.String()
}

// extractTestPackage extracts the Go package path from a test command.
func extractTestPackage(cmd string) string {
	fields := strings.Fields(cmd)
	for _, f := range fields {
		if strings.HasPrefix(f, "./") || strings.HasPrefix(f, ".") {
			return f
		}
	}
	return ""
}

// asyncPreGenCoaching fires a background goroutine to pre-generate AI coaching
// for the next UserPromptSubmit. Uses the current session context so the cached
// coaching is ready before the next turn.
func asyncPreGenCoaching(sdb *sessiondb.SessionDB, sessionID string) {
	// Gather context synchronously (sdb is not goroutine-safe).
	taskType, _ := sdb.GetContext("task_type")
	domain, _ := sdb.GetWorkingSet("domain")
	cwd, _ := sdb.GetContext("cwd")
	if taskType == "" || cwd == "" {
		return
	}

	phase, _ := sdb.GetContext("prev_phase")
	intent, _ := sdb.GetWorkingSet("intent")
	files, _ := sdb.GetWorkingSetFiles()
	decisions, _ := sdb.GetWorkingSetDecisions()

	var recentErrors []string
	if errEvents, _ := sdb.GetStructuredEventsByCategory("error"); len(errEvents) > 0 {
		limit := len(errEvents)
		if limit > 3 {
			limit = 3
		}
		for _, e := range errEvents[:limit] {
			recentErrors = append(recentErrors, e.Summary)
		}
	}

	cc := coach.CoachingContext{
		TaskType:     taskType,
		Domain:       domain,
		Phase:        phase,
		Intent:       intent,
		Files:        files,
		RecentErrors: recentErrors,
	}
	if len(decisions) > 3 {
		cc.Decisions = decisions[:3]
	} else {
		cc.Decisions = decisions
	}

	// Fire and forget: the goroutine writes to llm_cache via its own sdb/store.
	go func() {
		genSDB, err := sessiondb.Open(sessionID)
		if err != nil {
			return
		}
		defer genSDB.Close()

		ctx := context.Background()
		result, err := coach.GenerateCoachingWithContext(ctx, genSDB, cc, 5*time.Second)
		if err != nil || result == nil {
			return
		}

		var text string
		if result.Situation != "" {
			text = fmt.Sprintf("SITUATION: %s\nWHY: %s\nSUGGESTION: %s",
				result.Situation, result.Reasoning, result.Suggestion)
		} else {
			text = result.Suggestion
		}

		if genST, err := store.OpenDefaultCached(); err == nil {
			_ = genST.SetCachedCoaching(cwd, taskType, domain, text, "")
		}
	}()
}

func hashInput(toolName string, toolInput json.RawMessage) uint64 {
	h := fnv.New64a()
	h.Write([]byte(toolName))
	h.Write([]byte(":"))
	var buf bytes.Buffer
	if err := json.Compact(&buf, toolInput); err == nil {
		h.Write(buf.Bytes())
	} else {
		h.Write(toolInput)
	}
	return h.Sum64()
}

// surfaceCoChanges delivers a co-change hint after a successful write,
// listing files that are frequently edited together but not yet modified.
func surfaceCoChanges(sdb *sessiondb.SessionDB, filePath string) {
	cooldownKey := "cochange_post:" + filepath.Base(filePath)
	on, _ := sdb.IsOnCooldown(cooldownKey)
	if on {
		return
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		return
	}

	coFiles, err := st.CoChangedFiles(filePath, 3)
	if err != nil || len(coFiles) == 0 {
		return
	}

	// Filter out files already in the working set.
	wsFiles, _ := sdb.GetWorkingSetFiles()
	wsSet := make(map[string]bool, len(wsFiles))
	for _, f := range wsFiles {
		wsSet[f] = true
	}

	var missing []string
	for _, co := range coFiles {
		peer := co.FileA
		if peer == filePath {
			peer = co.FileB
		}
		if !wsSet[peer] {
			missing = append(missing, filepath.Base(peer))
		}
	}

	if len(missing) == 0 {
		return
	}

	_ = sdb.SetCooldown(cooldownKey, 15*time.Minute)
	Deliver(sdb, "co-change", "info",
		fmt.Sprintf("%s is often changed with: %s", filepath.Base(filePath), strings.Join(missing, ", ")),
		"Consider reviewing these files for related changes.",
		PriorityMedium,
		"Files that historically change together often share assumptions — updating one without the other causes subtle bugs.")
}
