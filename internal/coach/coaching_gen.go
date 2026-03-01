package coach

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
)

// CoachingContext provides rich session context for AI coaching generation.
type CoachingContext struct {
	TaskType     string
	Domain       string
	Phase        string
	Files        []string // working set files
	Intent       string   // user's current task intent
	Decisions    []string // recent decisions (max 3)
	RecentErrors []string // recent error summaries (max 3)
	PastPatterns []string // related pattern titles (max 3)
	UserCluster  string   // conservative/balanced/aggressive
}

// CoachingResult holds a parsed AI coaching response.
type CoachingResult struct {
	Situation  string
	Reasoning  string
	Suggestion string
}

// GenerateCoaching produces AI-powered coaching text based on task context
// and past patterns. Returns "", nil if the LLM is unavailable (graceful skip).
func GenerateCoaching(ctx context.Context, sdb *sessiondb.SessionDB, taskType, domain string, patterns []string, timeout time.Duration) (string, error) {
	prompt := buildCoachingPrompt(taskType, domain, patterns)
	raw, err := Generate(ctx, sdb, prompt, timeout)
	if err != nil {
		if errors.Is(err, ErrClaudeNotFound) {
			return "", nil
		}
		return "", err
	}

	return strings.TrimSpace(raw), nil
}

// GenerateCoachingWithContext produces structured AI coaching using rich session context.
// Output follows SITUATION/WHY/SUGGESTION format for consistent parsing.
// Returns nil, nil if the LLM is unavailable (graceful skip).
func GenerateCoachingWithContext(ctx context.Context, sdb *sessiondb.SessionDB, cc CoachingContext, timeout time.Duration) (*CoachingResult, error) {
	prompt := buildContextualCoachingPrompt(cc)
	raw, err := Generate(ctx, sdb, prompt, timeout)
	if err != nil {
		if errors.Is(err, ErrClaudeNotFound) {
			return nil, nil
		}
		return nil, err
	}

	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}

	return ParseCoachingResult(raw), nil
}

// ParseCoachingResult parses SITUATION/WHY/SUGGESTION labeled output.
// Falls back to using the entire text as the suggestion if labels are missing.
func ParseCoachingResult(raw string) *CoachingResult {
	r := &CoachingResult{}
	lines := strings.Split(raw, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "SITUATION:"):
			r.Situation = strings.TrimSpace(strings.TrimPrefix(line, "SITUATION:"))
		case strings.HasPrefix(line, "WHY:"):
			r.Reasoning = strings.TrimSpace(strings.TrimPrefix(line, "WHY:"))
		case strings.HasPrefix(line, "SUGGESTION:"):
			r.Suggestion = strings.TrimSpace(strings.TrimPrefix(line, "SUGGESTION:"))
		}
	}

	// Fallback: if no labels found, use whole text as suggestion.
	if r.Situation == "" && r.Reasoning == "" && r.Suggestion == "" {
		r.Suggestion = raw
	}

	return r
}

// CacheKey returns a deterministic cache key for this coaching context.
func (cc CoachingContext) CacheKey() string {
	// Hash files to keep key short.
	fileHash := ""
	if len(cc.Files) > 0 {
		fileHash = fmt.Sprintf("%d", len(cc.Files))
	}
	return fmt.Sprintf("coaching:%s:%s:%s:%s", cc.TaskType, cc.Domain, cc.Phase, fileHash)
}

// buildCoachingPrompt constructs the LLM prompt from task context.
func buildCoachingPrompt(taskType, domain string, patterns []string) string {
	var b strings.Builder

	b.WriteString("You are a coding coach. Generate a brief, actionable coaching message (2-4 sentences) for the developer.\n\n")

	if taskType != "" {
		fmt.Fprintf(&b, "Task type: %s\n", taskType)
	}
	if domain != "" {
		fmt.Fprintf(&b, "Domain: %s\n", domain)
	}

	if len(patterns) > 0 {
		b.WriteString("\nPast patterns from this project:\n")
		for _, p := range patterns {
			fmt.Fprintf(&b, "- %s\n", p)
		}
	}

	b.WriteString("\nProvide coaching that is specific to the context above. Focus on the most impactful advice. Return only the coaching text, no labels or formatting.")

	return b.String()
}

// buildContextualCoachingPrompt constructs a rich prompt for context-aware coaching.
func buildContextualCoachingPrompt(cc CoachingContext) string {
	var b strings.Builder

	b.WriteString(`You are a coding coach providing real-time guidance during an active session.
Generate coaching in exactly this format (3 lines, labels in ASCII):

SITUATION: [What is happening right now — 1 sentence]
WHY: [Why this matters for the developer's success — 1-2 sentences, cite evidence from context]
SUGGESTION: [Specific next action — 1 sentence, include a command if applicable]

`)

	fmt.Fprintf(&b, "Task type: %s\n", cc.TaskType)
	if cc.Domain != "" && cc.Domain != "general" {
		fmt.Fprintf(&b, "Domain: %s\n", cc.Domain)
	}
	if cc.Phase != "" {
		fmt.Fprintf(&b, "Current phase: %s\n", cc.Phase)
	}
	if cc.Intent != "" {
		fmt.Fprintf(&b, "Task intent: %s\n", cc.Intent)
	}
	if cc.UserCluster != "" {
		fmt.Fprintf(&b, "Developer profile: %s\n", cc.UserCluster)
	}

	if len(cc.Files) > 0 {
		limit := len(cc.Files)
		if limit > 5 {
			limit = 5
		}
		b.WriteString("\nActive files:\n")
		for _, f := range cc.Files[:limit] {
			fmt.Fprintf(&b, "- %s\n", f)
		}
	}

	if len(cc.RecentErrors) > 0 {
		b.WriteString("\nRecent errors:\n")
		for _, e := range cc.RecentErrors {
			fmt.Fprintf(&b, "- %s\n", e)
		}
	}

	if len(cc.Decisions) > 0 {
		b.WriteString("\nRecent decisions:\n")
		for _, d := range cc.Decisions {
			fmt.Fprintf(&b, "- %s\n", d)
		}
	}

	if len(cc.PastPatterns) > 0 {
		b.WriteString("\nRelevant past patterns:\n")
		for _, p := range cc.PastPatterns {
			fmt.Fprintf(&b, "- %s\n", p)
		}
	}

	b.WriteString("\nReturn ONLY the 3 labeled lines. No markdown, no extra text.")

	return b.String()
}
