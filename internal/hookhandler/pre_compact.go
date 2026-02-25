package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

type preCompactInput struct {
	CommonInput
	Trigger            string `json:"trigger"`
	CustomInstructions string `json:"custom_instructions"`
}

func handlePreCompact(input []byte) (*HookOutput, error) {
	var in preCompactInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] PreCompact: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	// Record compact event.
	_ = sdb.RecordCompact()

	// Check for context thrashing (2+ compacts in 15 minutes).
	count, _ := sdb.CompactsInWindow(15)
	if count >= 2 {
		onCooldown, _ := sdb.IsOnCooldown("context_thrashing")
		if !onCooldown {
			_ = sdb.EnqueueNudge(
				"context_thrashing", "warn",
				fmt.Sprintf("%d compacts in the last 15 minutes — context is being consumed rapidly", count),
				"Summarize the current goal and constraints in 2-3 bullets, then continue with focused steps",
			)
			_ = sdb.SetCooldown("context_thrashing", 15*60*1e9) // 15 min in nanoseconds
		}
	}

	// PreCompact does not support additionalContext, so return nil.
	return nil, nil
}
