package advice

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/hir4ta/claude-buddy/internal/ollama"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

// ModelTier selects the LLM tier for different use cases.
type ModelTier int

const (
	// TierFast is for classification tasks (< 1s).
	TierFast ModelTier = iota
	// TierSmart is for analysis tasks (2-4s).
	TierSmart
	// TierDeep is for session summaries (async, 5-10s).
	TierDeep
)

// Default model names per tier.
const (
	FastModel  = "qwen2.5-coder:1.5b"
	SmartModel = "qwen3:4b"
	DeepModel  = "qwen2.5-coder:7b"
)

// DefaultModel is the primary generation model (smart tier).
const DefaultModel = SmartModel

// ModelForTier returns the model name for a given tier,
// respecting BUDDY_GEN_MODEL override for the smart tier.
func ModelForTier(tier ModelTier) string {
	switch tier {
	case TierFast:
		return FastModel
	case TierSmart:
		return ModelFromEnv()
	case TierDeep:
		if env := os.Getenv("BUDDY_DEEP_MODEL"); env != "" {
			return env
		}
		return DeepModel
	default:
		return ModelFromEnv()
	}
}

// ModelFromEnv returns the generation model from BUDDY_GEN_MODEL env var,
// falling back to DefaultModel.
func ModelFromEnv() string {
	if env := os.Getenv("BUDDY_GEN_MODEL"); env != "" {
		return env
	}
	return DefaultModel
}

// AllModels returns all model names for warmup.
func AllModels() []string {
	seen := make(map[string]bool)
	var models []string
	for _, m := range []string{FastModel, ModelFromEnv(), ModelForTier(TierDeep)} {
		if !seen[m] {
			seen[m] = true
			models = append(models, m)
		}
	}
	return models
}

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

// NewAdvisorForTier creates a new Advisor using the specified model tier.
func NewAdvisorForTier(client *ollama.Client, tier ModelTier) *Advisor {
	return &Advisor{client: client, model: ModelForTier(tier)}
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
		"root_cause": map[string]any{"type": "string"},
		"suggestion": map[string]any{"type": "string"},
		"confidence": map[string]any{"type": "string", "enum": []string{"high", "medium", "low"}},
	},
	"required": []string{"root_cause", "suggestion", "confidence"},
}

// fewShotExamples provides failure-type-specific examples for the LLM prompt.
var fewShotExamples = map[string]string{
	"edit_mismatch": `Example 1: {"root_cause":"Whitespace mismatch — file uses tabs but old_string used spaces","suggestion":"Read the file with exact line range to get current indentation, then retry Edit","confidence":"high"}
Example 2: {"root_cause":"File was modified by a concurrent Edit since last Read","suggestion":"Re-read the file to get current content before retrying the Edit","confidence":"high"}
Example 3: {"root_cause":"Function signature changed after a previous refactor","suggestion":"Read the file to find the current function signature, then update old_string accordingly","confidence":"medium"}`,

	"compile_error": `Example 1: {"root_cause":"Missing import for a newly used package","suggestion":"Add the missing import statement at the top of the file","confidence":"high"}
Example 2: {"root_cause":"Type was renamed in a dependency but caller still uses old name","suggestion":"Check the dependency's exported types and update the reference","confidence":"medium"}
Example 3: {"root_cause":"Syntax error from incomplete edit — missing closing brace","suggestion":"Read the file around the error line and fix the syntax","confidence":"high"}`,

	"test_failure": `Example 1: {"root_cause":"Test assertion uses old expected value after behavior change","suggestion":"Update the test's expected value to match the new behavior","confidence":"high"}
Example 2: {"root_cause":"Test fixture references a renamed file or function","suggestion":"Update the test fixture to use the current name","confidence":"medium"}
Example 3: {"root_cause":"Race condition in concurrent test — shared state not protected","suggestion":"Add proper synchronization or use t.Parallel() with isolated state","confidence":"medium"}`,

	"bash_error": `Example 1: {"root_cause":"Command not found — tool not installed in this environment","suggestion":"Check if the tool exists with 'which <tool>' or install it first","confidence":"high"}
Example 2: {"root_cause":"Permission denied on file or directory","suggestion":"Check file permissions with 'ls -la' and fix with chmod if appropriate","confidence":"high"}`,

	"generic": `Example 1: {"root_cause":"File path has a typo — wrong directory or extension","suggestion":"Use Glob to find the correct file path","confidence":"high"}
Example 2: {"root_cause":"Operation timed out due to large file or slow network","suggestion":"Retry with a smaller scope or increase timeout","confidence":"medium"}`,
}

// GenerateFixSuggestion uses the LLM to generate a context-aware fix suggestion.
// Returns nil if the LLM call fails or times out.
func (a *Advisor) GenerateFixSuggestion(ctx context.Context, failureType, errorMsg, filePath, recentContext string) (*FixSuggestion, error) {
	examples := fewShotExamples[failureType]
	if examples == "" {
		examples = fewShotExamples["generic"]
	}

	prompt := fmt.Sprintf(`A Claude Code tool failed. Analyze and suggest a fix.

Failure type: %s
File: %s
Error: %s
Recent context: %s

Examples of good responses:
%s

Respond with root_cause (1 sentence), suggestion (1 specific action), and confidence.`,
		failureType, filePath, truncate(errorMsg, 500), truncate(recentContext, 300), examples)

	resp, err := a.client.Generate(ctx, &ollama.GenerateRequest{
		Model:     a.model,
		Prompt:    prompt,
		System:    "You are a concise debugging advisor for Claude Code. Always respond in valid JSON.",
		Format:    fixSuggestionSchema,
		Options:   map[string]any{"temperature": 0, "num_predict": 150},
		KeepAlive: -1,
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
		Model:     a.model,
		Prompt:    prompt,
		System:    "You are a session summarizer. Be concise and factual. Respond in valid JSON.",
		Format:    sessionSummarySchema,
		Options:   map[string]any{"temperature": 0, "num_predict": 300},
		KeepAlive: -1,
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

// IntentClassification is the structured output for task type classification.
type IntentClassification struct {
	TaskType   string `json:"task_type"`   // "bugfix", "feature", "refactor", "test", ""
	Confidence string `json:"confidence"`  // "high", "medium", "low"
}

var intentSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"task_type":  map[string]any{"type": "string", "enum": []string{"bugfix", "feature", "refactor", "test", ""}},
		"confidence": map[string]any{"type": "string", "enum": []string{"high", "medium", "low"}},
	},
	"required": []string{"task_type", "confidence"},
}

// ClassifyIntent uses TierFast to classify user task intent from a prompt.
// Returns nil on failure or timeout.
func (a *Advisor) ClassifyIntent(ctx context.Context, prompt string) (*IntentClassification, error) {
	p := fmt.Sprintf(`Classify this developer task prompt into one category.

Prompt: "%s"

Categories:
- "bugfix": fixing errors, bugs, crashes
- "feature": adding new functionality
- "refactor": reorganizing, cleaning, simplifying code
- "test": writing or updating tests
- "": unclear or none of the above

Respond with task_type and confidence.`, truncate(prompt, 200))

	resp, err := a.client.Generate(ctx, &ollama.GenerateRequest{
		Model:   ModelForTier(TierFast),
		Prompt:  p,
		System:  "Classify developer task intent. Respond in valid JSON only.",
		Format:  intentSchema,
		Options: map[string]any{"temperature": 0, "num_predict": 50},
	})
	if err != nil {
		return nil, fmt.Errorf("advice: classify intent: %w", err)
	}

	var result IntentClassification
	if err := json.Unmarshal([]byte(resp.Response), &result); err != nil {
		return nil, fmt.Errorf("advice: parse intent: %w", err)
	}
	return &result, nil
}

func truncate(s string, maxRunes int) string {
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	return string(runes[:maxRunes]) + "..."
}

