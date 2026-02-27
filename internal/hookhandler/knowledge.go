package hookhandler

import (
	"context"
	"strings"
	"time"
	"unicode"

	"github.com/hir4ta/claude-buddy/internal/embedder"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// Common error indicators in tool output.
var errorIndicators = []string{
	"error", "Error", "ERROR",
	"failed", "FAILED", "FAIL",
	"panic:", "fatal:",
	"not found", "No such file",
	"permission denied",
	"command not found",
	"cannot find",
	"undefined:",
	"compilation failed",
}

// containsError checks if text contains common error indicators.
func containsError(text string) bool {
	for _, indicator := range errorIndicators {
		if strings.Contains(text, indicator) {
			return true
		}
	}
	return false
}

// extractErrorSignature extracts a short searchable string from error output.
// Takes the first line containing an error keyword, truncated to 80 chars.
func extractErrorSignature(text string) string {
	lines := strings.Split(text, "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		for _, indicator := range errorIndicators {
			if strings.Contains(trimmed, indicator) {
				if len([]rune(trimmed)) > 80 {
					trimmed = string([]rune(trimmed)[:80])
				}
				return trimmed
			}
		}
	}
	// Fallback: first non-empty line.
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			if len([]rune(trimmed)) > 80 {
				trimmed = string([]rune(trimmed)[:80])
			}
			return trimmed
		}
	}
	return ""
}

// embedQuery creates a query embedding using cached Voyage API status.
// Returns nil if the embedder is unavailable or the request times out.
func embedQuery(sdb *sessiondb.SessionDB, text string, timeout time.Duration) []float32 {
	avail, _ := sdb.GetContext("embedder_available")
	if avail != "true" {
		return nil
	}

	emb := embedder.NewEmbedder()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	vec, err := emb.EmbedForSearch(ctx, text)
	if err != nil {
		_ = sdb.SetContext("embedder_available", "false")
		return nil
	}
	return vec
}

// searchErrorSolutions searches the main store for past error_solution patterns
// matching the given error signature using vector search.
func searchErrorSolutions(sdb *sessiondb.SessionDB, sig string) []store.PatternRow {
	if sig == "" {
		return nil
	}

	vec := embedQuery(sdb, sig, 2*time.Second)
	if vec == nil {
		return nil
	}

	st, err := store.OpenDefault()
	if err != nil {
		return nil
	}
	defer st.Close()

	patterns, _ := st.SearchPatternsByVector(vec, "error_solution", 3)
	return patterns
}

// extractKeywords extracts up to n meaningful keywords from text.
// Filters out common stop words and short tokens.
func extractKeywords(text string, n int) []string {
	// Split on non-alphanumeric characters.
	words := strings.FieldsFunc(text, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' && r != '-'
	})

	var keywords []string
	seen := make(map[string]bool)
	for _, w := range words {
		lower := strings.ToLower(w)
		if len(lower) < 3 || isStopWord(lower) || seen[lower] {
			continue
		}
		seen[lower] = true
		keywords = append(keywords, lower)
		if len(keywords) >= n {
			break
		}
	}
	return keywords
}

// formatSolution formats a single pattern as a nudge suggestion.
func formatSolution(p store.PatternRow) string {
	content := p.Content
	if len([]rune(content)) > 150 {
		content = string([]rune(content)[:150]) + "..."
	}
	return "Past solution: " + content
}

var stopWords = map[string]bool{
	// English
	"the": true, "and": true, "for": true, "are": true, "but": true,
	"not": true, "you": true, "all": true, "can": true, "has": true,
	"was": true, "one": true, "our": true, "out": true, "had": true,
	"this": true, "that": true, "with": true, "from": true, "they": true,
	"been": true, "have": true, "will": true, "each": true, "make": true,
	"like": true, "when": true, "what": true, "some": true, "them": true,
	"than": true, "its": true, "over": true, "such": true, "into": true,
	"just": true, "also": true, "more": true, "other": true, "then": true,
	"does": true, "here": true, "how": true, "use": true, "let": true,
}

func isStopWord(w string) bool {
	return stopWords[w]
}
