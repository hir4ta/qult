package advice

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/hir4ta/claude-buddy/internal/ollama"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

// DefaultModel is the default generation model.
const DefaultModel = "qwen2.5-coder:1.5b"

// Advisor provides LLM-augmented advice via Ollama /api/generate.
// It includes circuit breaker logic and graceful fallback.
type Advisor struct {
	client *ollama.Client
	model  string
}

// NewAdvisor creates a new Advisor with the given Ollama client and model.
func NewAdvisor(client *ollama.Client, model string) *Advisor {
	if model == "" {
		model = DefaultModel
	}
	return &Advisor{client: client, model: model}
}

// NewFromSessionDB creates an Advisor using cached Ollama settings from sessiondb.
// Returns nil if Ollama generation is unavailable or the circuit breaker is open.
func NewFromSessionDB(sdb *sessiondb.SessionDB) *Advisor {
	avail, _ := sdb.GetContext("ollama_gen_available")
	if avail != "true" {
		return nil
	}

	// Check circuit breaker.
	if isOpen, _ := sdb.GetContext("ollama_gen_breaker"); isOpen == "open" {
		probeAt, _ := sdb.GetContext("ollama_gen_probe_at")
		if probeAt != "" {
			t, err := time.Parse(time.RFC3339, probeAt)
			if err != nil || time.Now().Before(t) {
				return nil // still in cooldown
			}
			// Half-open: allow one probe
		} else {
			return nil
		}
	}

	model, _ := sdb.GetContext("ollama_gen_model")
	if model == "" {
		model = DefaultModel
	}
	return &Advisor{
		client: ollama.NewClient(""),
		model:  model,
	}
}

// FixSuggestion is the structured output for failure fix suggestions.
type FixSuggestion struct {
	RootCause  string `json:"root_cause"`
	Suggestion string `json:"suggestion"`
	Confidence string `json:"confidence"` // "high", "medium", "low"
}

// fixSuggestionSchema is the JSON schema for structured output.
var fixSuggestionSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"root_cause":  map[string]any{"type": "string"},
		"suggestion":  map[string]any{"type": "string"},
		"confidence":  map[string]any{"type": "string", "enum": []string{"high", "medium", "low"}},
	},
	"required": []string{"root_cause", "suggestion", "confidence"},
}

// GenerateFixSuggestion uses the LLM to generate a context-aware fix suggestion.
// Returns nil if the LLM call fails or times out.
func (a *Advisor) GenerateFixSuggestion(ctx context.Context, failureType, errorMsg, filePath, recentContext string) (*FixSuggestion, error) {
	prompt := fmt.Sprintf(`A Claude Code tool failed. Analyze and suggest a fix.

Failure type: %s
File: %s
Error: %s
Recent context: %s

Respond with root_cause (1 sentence), suggestion (1 specific action), and confidence.`,
		failureType, filePath, truncate(errorMsg, 500), truncate(recentContext, 300))

	resp, err := a.client.Generate(ctx, &ollama.GenerateRequest{
		Model:   a.model,
		Prompt:  prompt,
		System:  "You are a concise debugging advisor for Claude Code. Always respond in valid JSON.",
		Format:  fixSuggestionSchema,
		Options: map[string]any{"temperature": 0, "num_predict": 150},
	})
	if err != nil {
		return nil, fmt.Errorf("advice: generate: %w", err)
	}

	var fix FixSuggestion
	if err := json.Unmarshal([]byte(resp.Response), &fix); err != nil {
		return nil, fmt.Errorf("advice: parse response: %w", err)
	}

	return &fix, nil
}

// SessionSummary is the structured output for session summarization.
type SessionSummary struct {
	Summary      string   `json:"summary"`
	KeyDecisions []string `json:"key_decisions"`
	OpenQuestions []string `json:"open_questions"`
	NextSteps    []string `json:"next_steps"`
}

// sessionSummarySchema is the JSON schema for session summary.
var sessionSummarySchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"summary":        map[string]any{"type": "string"},
		"key_decisions":  map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		"open_questions": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		"next_steps":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
	},
	"required": []string{"summary", "key_decisions"},
}

// GenerateSessionSummary summarizes a session's progress for context preservation.
func (a *Advisor) GenerateSessionSummary(ctx context.Context, workingSetDump string) (*SessionSummary, error) {
	prompt := fmt.Sprintf(`Summarize this Claude Code session's progress concisely.

Session state:
%s

Respond with: summary (2-3 sentences), key_decisions (list), open_questions (list), next_steps (list).`,
		truncate(workingSetDump, 1500))

	resp, err := a.client.Generate(ctx, &ollama.GenerateRequest{
		Model:   a.model,
		Prompt:  prompt,
		System:  "You are a session summarizer. Be concise and factual. Respond in valid JSON.",
		Format:  sessionSummarySchema,
		Options: map[string]any{"temperature": 0, "num_predict": 300},
	})
	if err != nil {
		return nil, fmt.Errorf("advice: generate summary: %w", err)
	}

	var summary SessionSummary
	if err := json.Unmarshal([]byte(resp.Response), &summary); err != nil {
		return nil, fmt.Errorf("advice: parse summary: %w", err)
	}

	return &summary, nil
}

// RecordSuccess resets the circuit breaker on a successful LLM call.
func (a *Advisor) RecordSuccess(sdb *sessiondb.SessionDB) {
	_ = sdb.SetContext("ollama_gen_breaker", "closed")
	_ = sdb.SetContext("ollama_gen_failures", "0")
}

// RecordFailure increments the failure count and trips the breaker after 3 consecutive failures.
func (a *Advisor) RecordFailure(sdb *sessiondb.SessionDB) {
	countStr, _ := sdb.GetContext("ollama_gen_failures")
	count := 0
	fmt.Sscanf(countStr, "%d", &count)
	count++

	_ = sdb.SetContext("ollama_gen_failures", fmt.Sprintf("%d", count))

	if count >= 3 {
		_ = sdb.SetContext("ollama_gen_breaker", "open")
		probeAt := time.Now().Add(5 * time.Minute).Format(time.RFC3339)
		_ = sdb.SetContext("ollama_gen_probe_at", probeAt)
	}
}

func truncate(s string, maxRunes int) string {
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	return string(runes[:maxRunes]) + "..."
}
