package hookhandler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/advice"
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
			_ = sdb.SetCooldown("context_thrashing", 15*time.Minute)
		}
	}

	// Serialize working set to nudge outbox for post-compact restoration.
	serializeWorkingSetForCompact(sdb)

	// PreCompact does not support additionalContext, so return nil.
	return nil, nil
}

// serializeWorkingSetForCompact captures the current working context and enqueues
// it as a nudge so that handlePostCompactResume can restore it after compaction.
func serializeWorkingSetForCompact(sdb *sessiondb.SessionDB) {
	ws, err := sdb.GetAllWorkingSet()
	if err != nil || len(ws) == 0 {
		return
	}

	var b strings.Builder
	b.WriteString("[buddy] Working context preserved across compact:\n")

	if intent, ok := ws["intent"]; ok && intent != "" {
		fmt.Fprintf(&b, "Current goal: %s\n", intent)
	}
	if taskType, ok := ws["task_type"]; ok && taskType != "" {
		fmt.Fprintf(&b, "Task type: %s\n", taskType)
	}
	if branch, ok := ws["git_branch"]; ok && branch != "" {
		fmt.Fprintf(&b, "Branch: %s\n", branch)
	}

	files, _ := sdb.GetWorkingSetFiles()
	if len(files) > 0 {
		b.WriteString("Files being edited:\n")
		for _, f := range files {
			fmt.Fprintf(&b, "  - %s\n", f)
		}
	}

	decisions, _ := sdb.GetWorkingSetDecisions()
	if len(decisions) > 0 {
		b.WriteString("Key decisions this session:\n")
		for _, d := range decisions {
			fmt.Fprintf(&b, "  - %s\n", d)
		}
	}

	// Try LLM narrative summary to augment the deterministic facts.
	if narrative := generateCompactSummary(sdb, b.String()); narrative != "" {
		b.WriteString("\nSession narrative:\n")
		b.WriteString(narrative)
		b.WriteString("\n")
	}

	_ = sdb.EnqueueNudge("compact_context", "info",
		"Session context preserved for post-compact restoration",
		b.String(),
	)
}

// generateCompactSummary uses the LLM to produce a concise narrative of session progress.
// Returns empty string if LLM is unavailable or times out (deterministic facts remain).
func generateCompactSummary(sdb *sessiondb.SessionDB, factsDump string) string {
	advisor := advice.NewFromSessionDB(sdb)
	if advisor == nil {
		return ""
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	summary, err := advisor.GenerateSessionSummary(ctx, factsDump)
	if err != nil {
		advisor.RecordFailure(sdb)
		return ""
	}
	advisor.RecordSuccess(sdb)

	var b strings.Builder
	if summary.Summary != "" {
		b.WriteString(summary.Summary)
	}
	if len(summary.OpenQuestions) > 0 {
		b.WriteString("\nOpen questions: ")
		b.WriteString(strings.Join(summary.OpenQuestions, "; "))
	}
	if len(summary.NextSteps) > 0 {
		b.WriteString("\nNext steps: ")
		b.WriteString(strings.Join(summary.NextSteps, "; "))
	}
	return b.String()
}
