package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

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

	// Open session DB for context-aware checks and nudge delivery.
	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] PreToolUse: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	// Edit/Write guidance: warn if file was read many times without success.
	if in.ToolName == "Edit" || in.ToolName == "Write" {
		if guidance := editGuidance(sdb, in.ToolInput); guidance != "" {
			return makeOutput("PreToolUse", guidance), nil
		}
	}

	// Dequeue pending nudges as additionalContext.
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

// editGuidance checks if a file being edited was read many times,
// suggesting the Edit may fail due to stale content.
func editGuidance(sdb *sessiondb.SessionDB, toolInput json.RawMessage) string {
	var ei struct {
		FilePath string `json:"file_path"`
	}
	if json.Unmarshal(toolInput, &ei) != nil || ei.FilePath == "" {
		return ""
	}

	_, _, fileReads, err := sdb.BurstState()
	if err != nil {
		return ""
	}

	count := fileReads[ei.FilePath]
	if count < 4 {
		return ""
	}

	// Only warn once per file per burst.
	key := "edit_guidance:" + ei.FilePath
	on, _ := sdb.IsOnCooldown(key)
	if on {
		return ""
	}

	// 10-minute cooldown is enough — this file won't be read that many times again.
	_ = sdb.SetCooldown(key, 10*time.Minute)

	return fmt.Sprintf("[buddy] This file was Read %dx in this burst. If Edit fails, the old_string may not match current content — try Read first to get the latest.", count)
}
