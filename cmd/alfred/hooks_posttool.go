package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// handlePostToolUse fires after a tool executes.
// For Bash commands that fail (exit code != 0), searches memory for
// similar past errors and injects relevant solutions as additionalContext.
func handlePostToolUse(ctx context.Context, ev *hookEvent) {
	if ev.ToolName != "Bash" {
		return
	}

	// Parse tool_response to check for errors.
	var resp struct {
		Stdout   string `json:"stdout"`
		Stderr   string `json:"stderr"`
		ExitCode int    `json:"exitCode"`
	}
	if err := json.Unmarshal(ev.ToolResponse, &resp); err != nil {
		return
	}

	// Only act on failures.
	if resp.ExitCode == 0 {
		return
	}

	// Extract error keywords from stderr (or stdout if stderr is empty).
	errorText := resp.Stderr
	if errorText == "" {
		errorText = resp.Stdout
	}
	if len(errorText) > 2000 {
		errorText = errorText[:2000]
	}

	keywords := extractErrorKeywords(errorText)
	if len(keywords) == 0 {
		return
	}

	// Search memory for related past errors.
	query := strings.Join(keywords, " ")
	st, err := openStore()
	if err != nil {
		return
	}

	docs, err := st.SearchMemoriesFTS(ctx, query, 2)
	if err != nil || len(docs) == 0 {
		return
	}

	var buf strings.Builder
	buf.WriteString("Related past experience for this error:\n")
	for _, d := range docs {
		snippet := safeSnippet(d.Content, 300)
		buf.WriteString(fmt.Sprintf("- [%s] %s\n", d.SectionPath, snippet))
	}

	emitAdditionalContext("PostToolUse", buf.String())
}

// extractErrorKeywords pulls meaningful terms from error output.
// Looks for common error patterns: package names, function names, error types.
func extractErrorKeywords(text string) []string {
	// Take first 5 lines of error (most relevant).
	lines := strings.Split(text, "\n")
	if len(lines) > 5 {
		lines = lines[:5]
	}

	seen := make(map[string]bool)
	var keywords []string

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Extract words that look meaningful (4+ chars, not common noise).
		for _, word := range strings.Fields(line) {
			// Clean punctuation.
			word = strings.Trim(word, ".:;,()[]{}\"'`")
			lower := strings.ToLower(word)
			if len(lower) < 4 || isNoiseWord(lower) || seen[lower] {
				continue
			}
			seen[lower] = true
			keywords = append(keywords, lower)
			if len(keywords) >= 8 {
				return keywords
			}
		}
	}
	return keywords
}

// isNoiseWord returns true for common words that don't help search.
func isNoiseWord(w string) bool {
	noise := map[string]bool{
		"error": true, "fatal": true, "failed": true, "cannot": true,
		"could": true, "would": true, "should": true, "that": true,
		"this": true, "with": true, "from": true, "have": true,
		"line": true, "file": true, "exit": true, "code": true,
		"status": true, "expected": true, "unexpected": true,
	}
	return noise[w]
}

