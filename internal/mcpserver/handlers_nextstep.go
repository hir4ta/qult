package mcpserver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

// NextStep represents a recommended next action.
type NextStep struct {
	Action    string `json:"action"`
	Reasoning string `json:"reasoning"`
	Priority  string `json:"priority"`
	ToolHint  string `json:"tool_hint,omitempty"`
}

func nextStepHandler(claudeHome string) server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		sessionID := req.GetString("session_id", "")

		// Resolve session.
		var fullSessionID string
		if sessionID != "" {
			sessions, _ := watcher.ListSessions(claudeHome)
			for _, s := range sessions {
				if strings.HasPrefix(s.SessionID, sessionID) {
					fullSessionID = s.SessionID
					break
				}
			}
		} else {
			if s := findLatestSession(claudeHome); s != nil {
				fullSessionID = s.SessionID
			}
		}

		if fullSessionID == "" {
			return mcp.NewToolResultError("no active session found"), nil
		}

		dbPath := sessiondb.DBPath(fullSessionID)
		if _, err := os.Stat(dbPath); err != nil {
			return mcp.NewToolResultError("session database not found (hooks may not be installed)"), nil
		}

		sdb, err := sessiondb.Open(fullSessionID)
		if err != nil {
			return mcp.NewToolResultError("failed to open session db: " + err.Error()), nil
		}
		defer sdb.Close()

		userContext := req.GetString("context", "")
		steps := buildNextSteps(sdb, userContext)

		sid := fullSessionID
		if len(sid) > 8 {
			sid = sid[:8]
		}
		result := map[string]any{
			"session_id":  sid,
			"next_steps":  steps,
			"total_steps": len(steps),
		}

		// Include current session snapshot for context.
		if intent, _ := sdb.GetWorkingSet("intent"); intent != "" {
			result["current_intent"] = intent
		}
		if taskType, _ := sdb.GetWorkingSet("task_type"); taskType != "" {
			result["task_type"] = taskType
		}

		return marshalResult(result)
	}
}

// buildNextSteps generates up to 3 recommended next actions based on session state.
func buildNextSteps(sdb *sessiondb.SessionDB, userContext string) []NextStep {
	var steps []NextStep

	// Rule 1: Unresolved failures → fix first (high priority).
	hasUnresolvedTestFailure := false
	if step := checkUnresolvedFailures(sdb); step != nil {
		steps = append(steps, *step)
		if strings.Contains(step.Action, "test_failure") {
			hasUnresolvedTestFailure = true
		}
	}

	// Rule 2: Build failed → fix compilation (high priority).
	if lastBuild, _ := sdb.GetContext("last_build_passed"); lastBuild == "false" {
		steps = append(steps, NextStep{
			Action:    "Fix compilation errors — last build failed.",
			Reasoning: "Code changes won't be effective until the build passes.",
			Priority:  "high",
			ToolHint:  "Bash",
		})
	}

	// Rule 3: Code changed but tests not run → run tests (high priority).
	if step := checkTestsNeeded(sdb); step != nil {
		steps = append(steps, *step)
	}

	// Rule 4: Tests ran but failed → fix tests (high priority).
	// Skip if Rule 1 already reported an unresolved test failure.
	if !hasUnresolvedTestFailure {
		if step := checkTestsFailed(sdb); step != nil {
			steps = append(steps, *step)
		}
	}

	// Include user-provided context as a high-priority hint when present.
	if userContext != "" && len(steps) < 3 {
		steps = append(steps, NextStep{
			Action:    userContext,
			Reasoning: "User-specified goal for this step.",
			Priority:  "high",
		})
	}

	// Limit high-priority items.
	if len(steps) >= 3 {
		return steps[:3]
	}

	// Rule 5: File edited 3+ times → suggest plan mode (medium).
	if step := checkExcessiveEdits(sdb); step != nil {
		steps = append(steps, *step)
	}

	// Rule 6: Bigram prediction (medium).
	if step := checkBigramPrediction(sdb); step != nil && len(steps) < 3 {
		steps = append(steps, *step)
	}

	// Rule 7: Long exploration phase → start implementing (medium).
	if step := checkExplorationPhase(sdb); step != nil && len(steps) < 3 {
		steps = append(steps, *step)
	}

	// Rule 8: Default playbook recommendation (low).
	if len(steps) < 3 {
		if step := defaultPlaybook(sdb); step != nil {
			steps = append(steps, *step)
		}
	}

	if len(steps) > 3 {
		steps = steps[:3]
	}
	return steps
}

func checkUnresolvedFailures(sdb *sessiondb.SessionDB) *NextStep {
	failures, _ := sdb.RecentFailures(3)
	for _, f := range failures {
		if f.FilePath == "" {
			continue
		}
		unresolved, failType, _ := sdb.HasUnresolvedFailure(f.FilePath)
		if !unresolved {
			continue
		}
		return &NextStep{
			Action:    fmt.Sprintf("Fix the %s in %s. Read the file first to get current content.", failType, filepath.Base(f.FilePath)),
			Reasoning: "There is an unresolved failure that needs to be addressed before continuing.",
			Priority:  "high",
			ToolHint:  "Read",
		}
	}
	return nil
}

func checkTestsNeeded(sdb *sessiondb.SessionDB) *NextStep {
	files, _ := sdb.GetWorkingSetFiles()
	if len(files) == 0 {
		return nil
	}
	hasTestRun, _ := sdb.GetContext("has_test_run")
	if hasTestRun == "true" {
		return nil
	}
	taskType, _ := sdb.GetWorkingSet("task_type")
	if taskType != "bugfix" && taskType != "feature" && taskType != "refactor" {
		return nil
	}
	return &NextStep{
		Action:    fmt.Sprintf("Run tests to verify your changes (%d files modified).", len(files)),
		Reasoning: "Code was modified but tests have not been run in this session.",
		Priority:  "high",
		ToolHint:  "Bash",
	}
}

func checkTestsFailed(sdb *sessiondb.SessionDB) *NextStep {
	hasTestRun, _ := sdb.GetContext("has_test_run")
	if hasTestRun != "true" {
		return nil
	}
	lastTestPassed, _ := sdb.GetContext("last_test_passed")
	if lastTestPassed != "false" {
		return nil
	}
	return &NextStep{
		Action:    "Fix the failing tests before continuing with new work.",
		Reasoning: "Tests were run but failed. Fixing tests ensures existing functionality is preserved.",
		Priority:  "high",
		ToolHint:  "Read",
	}
}

func checkExcessiveEdits(sdb *sessiondb.SessionDB) *NextStep {
	files, _ := sdb.GetWorkingSetFiles()
	for _, f := range files {
		count, _ := sdb.FileEditCount(f)
		if count >= 3 {
			return &NextStep{
				Action:    fmt.Sprintf("Consider using Plan Mode — %s has been edited %d times.", filepath.Base(f), count),
				Reasoning: "Multiple edits to the same file may indicate the approach needs rethinking.",
				Priority:  "medium",
				ToolHint:  "EnterPlanMode",
			}
		}
	}
	return nil
}

func checkBigramPrediction(sdb *sessiondb.SessionDB) *NextStep {
	prevTool, _ := sdb.GetContext("prev_tool")
	if prevTool == "" {
		return nil
	}
	predictions, _ := sdb.PredictNextTools(prevTool, 3)
	if len(predictions) == 0 {
		return nil
	}
	best := predictions[0]
	if best.Count < 3 || best.SuccessRate < 0.5 {
		return nil
	}
	return &NextStep{
		Action:    fmt.Sprintf("Based on workflow patterns, %s is commonly the next step after %s.", best.Tool, prevTool),
		Reasoning: fmt.Sprintf("Historical data: %d occurrences, %.0f%% success rate.", best.Count, best.SuccessRate*100),
		Priority:  "medium",
		ToolHint:  best.Tool,
	}
}

func checkExplorationPhase(sdb *sessiondb.SessionDB) *NextStep {
	phases, _ := sdb.GetRawPhaseSequence(20)
	if len(phases) < 10 {
		return nil
	}
	readCount := 0
	for _, p := range phases {
		if p == "read" {
			readCount++
		}
	}
	ratio := float64(readCount) / float64(len(phases))
	if ratio < 0.7 {
		return nil
	}
	return &NextStep{
		Action:    "Start implementing — you have enough context from reading.",
		Reasoning: fmt.Sprintf("%.0f%% of recent actions were reads. Consider switching to edits.", ratio*100),
		Priority:  "medium",
		ToolHint:  "Edit",
	}
}

func defaultPlaybook(sdb *sessiondb.SessionDB) *NextStep {
	taskType, _ := sdb.GetWorkingSet("task_type")
	switch taskType {
	case "bugfix":
		return &NextStep{
			Action:    "Reproduce the bug, read the failing code, write a fix, and run tests.",
			Reasoning: "Standard bugfix workflow: reproduce → understand → fix → verify.",
			Priority:  "low",
		}
	case "feature":
		return &NextStep{
			Action:    "Review related code, plan the implementation, write code, and add tests.",
			Reasoning: "Standard feature workflow: explore → plan → implement → test.",
			Priority:  "low",
		}
	case "refactor":
		return &NextStep{
			Action:    "Run tests first, then refactor incrementally, testing after each change.",
			Reasoning: "Standard refactor workflow: baseline tests → incremental changes → verify.",
			Priority:  "low",
		}
	default:
		return &NextStep{
			Action:    "Check the current task status and continue with the next logical step.",
			Reasoning: "No specific task type detected — review your progress and continue.",
			Priority:  "low",
		}
	}
}
