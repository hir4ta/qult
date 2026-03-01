package coach

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
)

// PatternResult represents a single extracted knowledge pattern.
type PatternResult struct {
	Type       string  `json:"type"`       // error_solution, architecture, decision
	Title      string  `json:"title"`      // short summary
	Content    string  `json:"content"`    // reusable knowledge
	Confidence float64 `json:"confidence"` // 0.0-1.0 extraction confidence
}

const extractPrompt = `You are analyzing a coding session to extract reusable knowledge for future sessions.
Read the session summary below as a STORY: what problem was tackled, what was tried, what worked, and what was learned.

Return a JSON array of objects with these fields:
- "type": one of "error_solution", "architecture", "decision"
- "title": short summary (under 80 chars)
- "content": the reusable knowledge (1-3 sentences)
- "confidence": 0.0-1.0 how confident you are this is genuinely reusable

Guidelines per type:
- error_solution: Describe what failed AND what fixed it. Include the before/after if visible (e.g. "Changed X to Y in file Z").
- architecture: Explain WHY a particular approach was chosen, not just what was done.
- decision: Capture the trade-off reasoning — what alternatives existed and why this one won.

Only include genuinely reusable patterns (confidence >= 0.5). If nothing is worth extracting, return [].
Return ONLY the JSON array, no other text.

Session:
`

// ExtractPatterns uses the LLM to extract reusable knowledge from session events.
// Returns nil, nil if the LLM is unavailable (graceful skip).
func ExtractPatterns(ctx context.Context, sdb *sessiondb.SessionDB, events string, timeout time.Duration) ([]PatternResult, error) {
	if events == "" {
		return nil, nil
	}

	prompt := extractPrompt + events
	raw, err := Generate(ctx, sdb, prompt, timeout)
	if err != nil {
		if errors.Is(err, ErrClaudeNotFound) {
			return nil, nil
		}
		return nil, err
	}

	if raw == "" {
		return nil, nil
	}

	// Strip markdown code fences if present.
	raw = stripCodeFence(raw)

	var results []PatternResult
	if err := json.Unmarshal([]byte(raw), &results); err != nil {
		return nil, nil
	}

	// Filter out low-confidence extractions.
	filtered := results[:0]
	for _, r := range results {
		if r.Confidence >= 0.5 || r.Confidence == 0 {
			filtered = append(filtered, r)
		}
	}

	return filtered, nil
}

// stripCodeFence removes ```json ... ``` wrapping from LLM output.
func stripCodeFence(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		// Remove opening fence line.
		if idx := strings.Index(s, "\n"); idx >= 0 {
			s = s[idx+1:]
		}
		// Remove closing fence.
		if idx := strings.LastIndex(s, "```"); idx >= 0 {
			s = s[:idx]
		}
		s = strings.TrimSpace(s)
	}
	return s
}
