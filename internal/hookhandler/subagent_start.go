package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

type subagentStartInput struct {
	CommonInput
	AgentName string `json:"agent_name"`
	AgentType string `json:"agent_type"`
	TaskID    string `json:"task_id,omitempty"`
}

// handleSubagentStart injects working set context into subagent additionalContext.
// This ensures subagents inherit the parent session's intent, task type, decisions,
// working files, and git branch.
func handleSubagentStart(input []byte) (*HookOutput, error) {
	var in subagentStartInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] SubagentStart: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	var parts []string

	if intent, _ := sdb.GetWorkingSet("intent"); intent != "" {
		parts = append(parts, fmt.Sprintf("Task intent: %s", intent))
	}
	if taskType, _ := sdb.GetWorkingSet("task_type"); taskType != "" {
		parts = append(parts, fmt.Sprintf("Task type: %s", taskType))
	}
	if branch, _ := sdb.GetWorkingSet("git_branch"); branch != "" {
		parts = append(parts, fmt.Sprintf("Git branch: %s", branch))
	}
	if decisions, _ := sdb.GetWorkingSetDecisions(); len(decisions) > 0 {
		limit := min(3, len(decisions))
		parts = append(parts, "Recent decisions:")
		for _, d := range decisions[:limit] {
			parts = append(parts, fmt.Sprintf("  - %s", d))
		}
	}
	if files, _ := sdb.GetWorkingSetFiles(); len(files) > 0 {
		limit := min(10, len(files))
		parts = append(parts, fmt.Sprintf("Active files: %s", strings.Join(files[:limit], ", ")))
	}

	if len(parts) == 0 {
		return nil, nil
	}

	ctx := "[buddy] Parent session context:\n" + strings.Join(parts, "\n")
	return makeOutput("SubagentStart", ctx), nil
}
