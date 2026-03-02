package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Decision represents a design decision extracted by the LLM.
type Decision struct {
	Topic     string   `json:"topic"`
	Decision  string   `json:"decision"`
	Reasoning string   `json:"reasoning,omitempty"`
	FilePaths []string `json:"file_paths,omitempty"`
}

const decisionSystemPrompt = `You extract design decisions from AI coding assistant messages.
A "design decision" is a choice that affects architecture, implementation, or workflow.
Examples: choosing a library, API design, file organization, pattern selection.
NOT decisions: routine code generation, obvious bug fixes, file reads, test runs.

Output a JSON array of 0-5 objects:
- topic: 5-15 word summary (same language as the message)
- decision: 1-2 sentence description of the choice made
- reasoning: why this choice was made (empty string if not stated)
- file_paths: mentioned file paths (empty array if none)

No decisions found? Return []. Output ONLY valid JSON, no markdown fences.`

// ExtractDecisions calls Haiku to extract design decisions from an assistant message.
// Returns nil on any error (graceful degradation).
func (c *Client) ExtractDecisions(ctx context.Context, assistantText string) ([]Decision, error) {
	// Skip short messages — unlikely to contain decisions.
	if len(assistantText) < 100 {
		return nil, nil
	}

	// Truncate very long messages to stay within Haiku's input budget.
	if len(assistantText) > 30000 {
		assistantText = assistantText[:30000]
	}

	text, err := c.client.chat(ctx, decisionSystemPrompt, assistantText, 1024)
	if err != nil {
		return nil, fmt.Errorf("llm: extract decisions: %w", err)
	}

	// Strip markdown code fences if present.
	text = strings.TrimSpace(text)
	text = strings.TrimPrefix(text, "```json")
	text = strings.TrimPrefix(text, "```")
	text = strings.TrimSuffix(text, "```")
	text = strings.TrimSpace(text)

	var decisions []Decision
	if err := json.Unmarshal([]byte(text), &decisions); err != nil {
		return nil, fmt.Errorf("llm: parse decisions: %w", err)
	}

	if len(decisions) > 5 {
		decisions = decisions[:5]
	}

	return decisions, nil
}
