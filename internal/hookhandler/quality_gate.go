package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

type qualityGateInput struct {
	CommonInput
	TaskID               string `json:"task_id,omitempty"`
	AgentName            string `json:"agent_name,omitempty"`
	LastAssistantMessage string `json:"last_assistant_message,omitempty"`
}

// handleQualityGate runs quality checks for TeammateIdle and TaskCompleted events.
// Checks for unresolved failures, untested code modifications, and subagent output quality.
func handleQualityGate(input []byte, eventName string) (*HookOutput, error) {
	var in qualityGateInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] %s: open session db: %v\n", eventName, err)
		return nil, nil
	}
	defer sdb.Close()

	var issues []string

	// Check for unresolved failures.
	failures, _ := sdb.RecentFailures(5)
	unresolvedCount := 0
	for _, f := range failures {
		if time.Since(f.Timestamp) > 15*time.Minute {
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
		issues = append(issues, fmt.Sprintf("%d unresolved failure(s)", unresolvedCount))
	}

	// Check if tests were run when code was modified.
	hasTestRun, _ := sdb.GetContext("has_test_run")
	files, _ := sdb.GetWorkingSetFiles()
	if hasTestRun != "true" && len(files) > 0 {
		taskType, _ := sdb.GetWorkingSet("task_type")
		if taskType == "bugfix" || taskType == "feature" || taskType == "refactor" {
			issues = append(issues, fmt.Sprintf("%d files modified but tests not run", len(files)))
		}
	}

	if len(issues) == 0 {
		return nil, nil
	}

	msg := fmt.Sprintf("[buddy] Quality gate (%s): %s", eventName, strings.Join(issues, "; "))

	if eventName == "TeammateIdle" {
		// Async delivery for TeammateIdle.
		return makeAsyncContextOutput(msg), nil
	}

	// Synchronous feedback for TaskCompleted.
	return makeOutput(eventName, msg), nil
}
