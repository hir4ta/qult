package hookhandler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
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

	isWrite := writeTools[in.ToolName]
	inputHash := hashInput(in.ToolName, in.ToolInput)

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

	// Track test command execution for workflow guidance.
	if in.ToolName == "Bash" {
		var bi struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(in.ToolInput, &bi) == nil && testCmdPattern.MatchString(bi.Command) {
			_ = sdb.SetContext("has_test_run", "true")

			// Positive signal: test-first recognition for bugfix/refactor.
			taskTypeStr, _ := sdb.GetContext("task_type")
			tc, hasWrite, _, _ := sdb.BurstState()
			if (taskTypeStr == "bugfix" || taskTypeStr == "refactor") && !hasWrite && tc <= 3 {
				set, _ := sdb.TrySetCooldown("test_first_ack", 30*time.Minute)
				if set && !shouldSuppressNudge("test-first") {
					_ = sdb.EnqueueNudge("test-first", "info",
						"Good practice: running tests before editing",
						"Test-first approach established. This gives a baseline to verify changes against.",
					)
				}
			}
		}
	}

	// Record tool outcome for prediction intelligence.
	filePath := extractFilePath(in.ToolInput)
	_ = sdb.RecordToolOutcome(in.ToolName, filePath, true) // success path

	// Record tool sequence for bigram prediction.
	prevTool, _ := sdb.GetContext("prev_tool")
	if prevTool != "" {
		_ = sdb.RecordSequence(prevTool, in.ToolName, "success")
	}
	_ = sdb.SetContext("prev_tool", in.ToolName)

	// Track files being edited in working set.
	if isWrite {
		if filePath != "" {
			_ = sdb.AddWorkingSetFile(filePath)
		}
	}

	// Failure→solution pipeline: record fix when Edit/Write succeeds after a failure.
	if isWrite && filePath != "" {
		recordFailureSolution(sdb, in.SessionID, filePath, in.ToolInput)
	}

	// Code quality heuristics on write operations.
	if isWrite && filePath != "" {
		if hint := runCodeHeuristics(filePath, in.ToolInput); hint != "" {
			cooldownKey := "code_hint:" + filepath.Base(filePath)
			set, _ := sdb.TrySetCooldown(cooldownKey, 5*time.Minute)
			if set && !shouldSuppressNudge("code-quality") {
				_ = sdb.EnqueueNudge("code-quality", "info",
					"Code quality observation", hint)
			}
		}
	}

	// Workflow order check — enqueue nudge if write doesn't match expected workflow.
	if isWrite {
		if nudge := checkWorkflowForCurrentTask(sdb); nudge != "" {
			if !shouldSuppressNudge("workflow") {
				_ = sdb.EnqueueNudge("workflow", "info", "Workflow suggestion", nudge)
			}
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
				if set && !shouldSuppressNudge("test-correlation") {
					_ = sdb.EnqueueNudge("test-correlation", "info",
						"Test failure correlated with recent edits", correlation)
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

	return nil, nil
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
		_ = sdb.EnqueueNudge("checkpoint", "info",
			fmt.Sprintf("Session checkpoint at %d tool calls", tc),
			fmt.Sprintf("%d unresolved failure(s) detected. Consider fixing before continuing.", unresolvedCount),
		)
		return
	}

	// Check if tests need running.
	hasTestRun, _ := sdb.GetContext("has_test_run")
	files, _ := sdb.GetWorkingSetFiles()
	if hasTestRun != "true" && len(files) > 3 {
		_ = sdb.EnqueueNudge("checkpoint", "info",
			fmt.Sprintf("Session checkpoint at %d tool calls", tc),
			fmt.Sprintf("%d files modified but tests not yet run. Consider running tests.", len(files)),
		)
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

	_ = sdb.EnqueueNudge("file-knowledge", "info",
		fmt.Sprintf("Past knowledge found for %s", filepath.Base(filePath)),
		msg,
	)
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

	_ = sdb.EnqueueNudge(
		"past-solution", "info",
		"Similar error found in past sessions",
		formatSolution(solutions[0]),
	)
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
	var edit struct {
		OldString string `json:"old_string"`
		NewString string `json:"new_string"`
	}
	if json.Unmarshal(toolInput, &edit) == nil && edit.NewString != "" {
		solution = fmt.Sprintf("Fixed %s by editing %s", f.FailureType, filepath.Base(filePath))
		if len([]rune(edit.NewString)) <= 200 {
			solution += fmt.Sprintf(": %s", edit.NewString)
		}
	} else {
		solution = fmt.Sprintf("Fixed %s by rewriting %s", f.FailureType, filepath.Base(filePath))
	}

	st, err := store.OpenDefault()
	if err != nil {
		return
	}
	defer st.Close()

	_ = st.InsertFailureSolution(sessionID, f.FailureType, f.ErrorSig, filePath, solution)

	// If a past solution was surfaced before this fix, mark it as effective.
	if idStr, _ := sdb.GetContext("last_surfaced_solution_id"); idStr != "" {
		var solutionID int
		if _, err := fmt.Sscanf(idStr, "%d", &solutionID); err == nil && solutionID > 0 {
			_ = st.IncrementTimesEffective(solutionID)
		}
		_ = sdb.SetContext("last_surfaced_solution_id", "")
	}
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
