package hookhandler

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

type userPromptInput struct {
	CommonInput
	Prompt string `json:"prompt"`
}

func handleUserPromptSubmit(input []byte) (*HookOutput, error) {
	var in userPromptInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, fmt.Errorf("parse input: %w", err)
	}

	sdb, err := sessiondb.Open(in.SessionID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] UserPromptSubmit: open session db: %v\n", err)
		return nil, nil
	}
	defer sdb.Close()

	// User turn boundary: reset burst counters and context.
	_ = sdb.ResetBurst()
	_ = sdb.SetContext("subagent_active", "")

	// Record user intent for context-aware detection.
	if in.Prompt != "" {
		intent := in.Prompt
		if len([]rune(intent)) > 100 {
			intent = string([]rune(intent)[:100])
		}
		_ = sdb.SetContext("last_user_intent", intent)
	}

	// Dequeue pending nudges (max 2).
	nudges, _ := sdb.DequeueNudges(2)

	entries := make([]nudgeEntry, 0, len(nudges)+1)
	for _, n := range nudges {
		entries = append(entries, nudgeEntry{
			Pattern:     n.Pattern,
			Level:       n.Level,
			Observation: n.Observation,
			Suggestion:  n.Suggestion,
		})
	}

	// Search for relevant past knowledge based on user's prompt.
	if knowledge := matchRelevantKnowledge(sdb, in.Prompt); knowledge != "" {
		entries = append(entries, nudgeEntry{
			Pattern:     "knowledge",
			Level:       "info",
			Observation: "Relevant past knowledge found",
			Suggestion:  knowledge,
		})
	}

	if len(entries) == 0 {
		return nil, nil
	}
	return makeOutput("UserPromptSubmit", formatNudges(entries)), nil
}

// matchRelevantKnowledge searches past patterns matching the user's prompt.
func matchRelevantKnowledge(sdb *sessiondb.SessionDB, prompt string) string {
	if len([]rune(prompt)) < 30 {
		return ""
	}

	// Cooldown to avoid repeated knowledge injection.
	on, _ := sdb.IsOnCooldown("knowledge_inject")
	if on {
		return ""
	}

	keywords := extractKeywords(prompt, 3)
	knowledge := searchRelevantKnowledge(sdb, keywords)
	if knowledge == "" {
		return ""
	}

	_ = sdb.SetCooldown("knowledge_inject", 5*time.Minute)
	return knowledge
}
