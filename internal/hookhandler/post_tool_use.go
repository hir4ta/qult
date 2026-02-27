package hookhandler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"strings"
	"time"

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
	}

	// Track test and build command execution for workflow guidance.
	if in.ToolName == "Bash" {
		var bi struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(in.ToolInput, &bi) == nil {
			hasError := len(in.ToolResponse) > 0 && containsError(string(in.ToolResponse))

			if testCmdPattern.MatchString(bi.Command) {
				_ = sdb.SetContext("has_test_run", "true")

				// Track test pass/fail status from tool response.
				if hasError {
					_ = sdb.SetContext("last_test_passed", "false")
				} else {
					_ = sdb.SetContext("last_test_passed", "true")
				}

				// Positive signal: test-first recognition for bugfix/refactor.
				taskTypeStr, _ := sdb.GetContext("task_type")
				tc, hasWrite, _, _ := sdb.BurstState()
				if (taskTypeStr == "bugfix" || taskTypeStr == "refactor") && !hasWrite && tc <= 3 {
					set, _ := sdb.TrySetCooldown("test_first_ack", 30*time.Minute)
					if set {
						Deliver(sdb, "test-first", "info",
							"Good practice: running tests before editing",
							"Test-first approach established. This gives a baseline to verify changes against.",
							PriorityMedium)
					}
				}
			}

			// Track build/compile success.
			if isCompileCommand(bi.Command) {
				if hasError {
					_ = sdb.SetContext("last_build_passed", "false")
				} else {
					_ = sdb.SetContext("last_build_passed", "true")
				}
			}
		}
	}

	// Update EWMA flow metrics (velocity, error rate).
	updateFlowMetrics(sdb, false)

	// Record health snapshot every 10 tool calls for trend prediction.
	recordHealthSnapshot(sdb)

	// Wall detection: velocity dropped sharply — deliver intervention.
	if IsWallDetected(sdb) {
		ClearWallDetected(sdb)
		if msg := buildWallIntervention(sdb); msg != "" {
			set, _ := sdb.TrySetCooldown("wall_intervention", 10*time.Minute)
			if set {
				Deliver(sdb, "wall-detected", "warning",
					"Productivity drop detected", msg, PriorityHigh)
			}
		}
	}

	// Record workflow phase for adaptive learning.
	recordPhase(sdb, in.ToolName, in.ToolInput)

	// Record tool outcome for prediction intelligence.
	filePath := extractFilePath(in.ToolInput)
	_ = sdb.RecordToolOutcome(in.ToolName, filePath, true) // success path

	// Record tool sequence for bigram prediction.
	prevTool, _ := sdb.GetContext("prev_tool")
	if prevTool != "" {
		_ = sdb.RecordSequence(prevTool, in.ToolName, "success")
	}

	// Record trigram for 3-tool sequence prediction.
	prevPrevTool, _ := sdb.GetContext("prev_prev_tool")
	if prevPrevTool != "" && prevTool != "" {
		_ = sdb.RecordTrigram(prevPrevTool, prevTool, in.ToolName, "success")
	}
	_ = sdb.SetContext("prev_prev_tool", prevTool)
	_ = sdb.SetContext("prev_tool", in.ToolName)

	// Track files being edited in working set.
	if isWrite {
		if filePath != "" {
			_ = sdb.AddWorkingSetFile(filePath)
		}
	}

	// Surface co-changed files after writes.
	if isWrite && filePath != "" {
		surfaceCoChanges(sdb, filePath)
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

	// Code quality heuristics on write operations.
	if isWrite && filePath != "" {
		if hint := runCodeHeuristics(filePath, in.ToolInput); hint != "" {
			cooldownKey := "code_hint:" + filepath.Base(filePath)
			set, _ := sdb.TrySetCooldown(cooldownKey, 5*time.Minute)
			if set {
				Deliver(sdb, "code-quality", "info",
					"Code quality observation", hint, PriorityMedium)
			}
		}
	}

	// Suggest specific test command after editing Go files.
	if isWrite && filePath != "" && filepath.Ext(filePath) == ".go" && !strings.HasSuffix(filePath, "_test.go") {
		suggestTestForEdit(sdb, filePath, in.ToolInput, in.CWD)
	}

	// Workflow order check — enqueue nudge if write doesn't match expected workflow.
	if isWrite {
		if nudge := checkWorkflowForCurrentTask(sdb); nudge != "" {
			Deliver(sdb, "workflow", "info", "Workflow suggestion", nudge, PriorityMedium)
		}
	}

	// Periodic checkpoint: every 20 tool calls, check session health.
	checkPeriodicHealth(sdb)

	// Run lightweight signal detection → deliver via additionalContext.
	det := &HookDetector{sdb: sdb}
	if signal := det.Detect(); signal != "" {
		return makeAsyncContextOutput(signal), nil
	}

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
			}
			matchPastErrorSolutions(sdb, resp)
		}

		// Test failure correlation: connect failures to recently edited files.
		if bi.Command != "" && testCmdPattern.MatchString(bi.Command) && containsError(resp) {
			failures := extractTestFailures(resp)
			if correlation := correlateWithRecentEdits(sdb, failures); correlation != "" {
				set, _ := sdb.TrySetCooldown("test_correlation", 3*time.Minute)
				if set {
					Deliver(sdb, "test-correlation", "info",
						"Test failure correlated with recent edits", correlation, PriorityMedium)
				}
			}
		}
	}

	// File-context knowledge: after Read/Edit/Write, search for related patterns.
	if in.ToolName == "Read" || isWrite {
		var fi struct {
			FilePath string `json:"file_path"`
		}
		if json.Unmarshal(in.ToolInput, &fi) == nil && fi.FilePath != "" {
			matchFileContextKnowledge(sdb, fi.FilePath)
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
			PriorityMedium)
		return
	}

	// Check if tests need running.
	hasTestRun, _ := sdb.GetContext("has_test_run")
	files, _ := sdb.GetWorkingSetFiles()
	if hasTestRun != "true" && len(files) > 3 {
		Deliver(sdb, "checkpoint", "info",
			fmt.Sprintf("Session checkpoint at %d tool calls", tc),
			fmt.Sprintf("%d files modified but tests not yet run. Consider running tests.", len(files)),
			PriorityMedium)
	}

	// Anomaly detection: explore/debug spiral.
	if alert := checkAnomaly(sdb); alert != "" {
		Deliver(sdb, "anomaly", "warning", "Behavioral pattern detected", alert, PriorityHigh)
	}

	// Health trend prediction: warn if declining toward threshold.
	if trend := PredictHealthTrend(sdb); trend != nil && trend.Trend == "declining" && trend.ToolsToThreshold > 0 {
		set, _ := sdb.TrySetCooldown("health_trend_warn", 15*time.Minute)
		if set {
			Deliver(sdb, "health-trend", "warning",
				fmt.Sprintf("Session health declining (%.0f%%)", trend.CurrentHealth*100),
				fmt.Sprintf("At current pace, health will drop below 50%% in ~%d tool calls. Consider taking a step back, running tests, or breaking the task into smaller steps.", trend.ToolsToThreshold),
				PriorityHigh)
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

	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

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
		formatSolution(solutions[0]), PriorityMedium)
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

	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

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

// recordPhase maps a tool call to a workflow phase and records it in sessiondb.
// It also detects phase transitions and sets the at_workflow_boundary flag.
func recordPhase(sdb *sessiondb.SessionDB, toolName string, toolInput json.RawMessage) {
	var phase string
	switch toolName {
	case "Read", "Grep", "Glob":
		phase = "read"
	case "Edit", "Write", "NotebookEdit":
		phase = "write"
	case "EnterPlanMode":
		phase = "plan"
	case "Bash":
		var bi struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(toolInput, &bi) == nil && bi.Command != "" {
			if testCmdPattern.MatchString(bi.Command) {
				phase = "test"
			} else if isCompileCommand(bi.Command) {
				phase = "compile"
			}
			// git commit is a workflow boundary (task completion signal).
			if isGitCommitCommand(bi.Command) {
				_ = sdb.SetContext("at_workflow_boundary", "true")
			}
		}
	case "TaskCreate", "TaskUpdate":
		// Task lifecycle events are workflow boundaries.
		_ = sdb.SetContext("at_workflow_boundary", "true")
	}
	if phase == "" {
		return
	}

	// Detect phase transition: compare with previous recorded phase.
	prevPhase, _ := sdb.GetContext("prev_phase")
	if prevPhase != "" && prevPhase != phase {
		_ = sdb.SetContext("at_workflow_boundary", "true")
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
			st, err := store.OpenDefault()
			if err == nil {
				_ = st.InsertSolutionChain(sessionID, chainSig, string(toolSeqJSON), step)
				st.Close()
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
		PriorityMedium)
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

	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

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
		PriorityMedium)
}
