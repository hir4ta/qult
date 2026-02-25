package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

type preToolUseInput struct {
	CommonInput
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
	ToolUseID string          `json:"tool_use_id"`
}

func handlePreToolUse(input []byte) (*HookOutput, error) {
	var in preToolUseInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	// Destructive command gate for Bash.
	if in.ToolName == "Bash" {
		var toolInput struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal(in.ToolInput, &toolInput); err == nil && toolInput.Command != "" {
			obs, sugg, matched := analyzer.MatchDestructiveCommand(toolInput.Command)
			if matched {
				reason := fmt.Sprintf("[buddy] %s\n→ %s", obs, sugg)
				return makeDenyOutput(reason), nil
			}
		}
	}

	// Dequeue pending nudges as additionalContext.
	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] PreToolUse: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	nudges, _ := sdb.DequeueNudges(1)
	if len(nudges) == 0 {
		return nil, nil
	}

	entries := make([]nudgeEntry, len(nudges))
	for i, n := range nudges {
		entries[i] = nudgeEntry{
			Pattern:     n.Pattern,
			Level:       n.Level,
			Observation: n.Observation,
			Suggestion:  n.Suggestion,
		}
	}
	return makeOutput("PreToolUse", formatNudges(entries)), nil
}
