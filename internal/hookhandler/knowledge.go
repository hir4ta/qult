package hookhandler

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"hash/fnv"
	"math"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/hir4ta/claude-buddy/internal/embedder"
	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// Process-level cached Embedder instance (avoids allocating new HTTP clients per call).
var (
	cachedEmbedder     *embedder.Embedder
	cachedEmbedderOnce sync.Once
)

func sharedEmbedder() *embedder.Embedder {
	cachedEmbedderOnce.Do(func() {
		cachedEmbedder = embedder.NewEmbedder()
	})
	return cachedEmbedder
}

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

// goTestFailPattern matches Go test runner failure output.
// "--- FAIL:" = individual test failure, "FAIL\t" at line start = package failure.
var goTestFailPattern = regexp.MustCompile(`(?m)(^--- FAIL:|^FAIL\t)`)

// isGoTestFailure detects Go test failures from command output.
// More precise than containsError — ignores log messages containing "error" or "FAIL"
// that aren't actual test results (e.g., buddy seed pattern logs).
func isGoTestFailure(output string) bool {
	return goTestFailPattern.MatchString(output)
}

// goBuildFailPattern matches Go compiler error output: "file.go:line:col: message".
var goBuildFailPattern = regexp.MustCompile(`(?m)^\S+\.go:\d+:\d+:`)

// isBuildFailure detects build/compile failures from command output.
// Matches Go compiler error format rather than generic keywords,
// preventing false positives from log messages containing "error" or "undefined".
func isBuildFailure(output string) bool {
	if goBuildFailPattern.MatchString(output) {
		return true
	}
	lower := strings.ToLower(output)
	return strings.Contains(lower, "compilation failed") || strings.Contains(lower, "build failed")
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
// Results are cached in sessiondb keyed by FNV hash of the query text
// to avoid repeated HTTP calls for the same query within a session.
func embedQuery(sdb *sessiondb.SessionDB, text string, timeout time.Duration) []float32 {
	avail, _ := sdb.GetContext("embedder_available")
	if avail != "true" {
		return nil
	}

	// Check sessiondb cache for this query's embedding vector.
	cacheKey := "embed_cache:" + embedCacheKey(text)
	if cached, _ := sdb.GetContext(cacheKey); cached != "" {
		if vec := decodeVector(cached); vec != nil {
			return vec
		}
	}

	emb := sharedEmbedder()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	vec, err := emb.EmbedForSearch(ctx, text)
	if err != nil {
		_ = sdb.SetContext("embedder_available", "false")
		return nil
	}

	// Cache the result in sessiondb for reuse within this session.
	if encoded := encodeVector(vec); encoded != "" {
		_ = sdb.SetContext(cacheKey, encoded)
	}
	return vec
}

// embedCacheKey returns a short FNV-1a hash string for use as a sessiondb key.
func embedCacheKey(text string) string {
	h := fnv.New64a()
	h.Write([]byte(text))
	buf := make([]byte, 8)
	binary.LittleEndian.PutUint64(buf, h.Sum64())
	return base64.RawURLEncoding.EncodeToString(buf)
}

// encodeVector encodes a float32 slice to a base64 string for sessiondb storage.
func encodeVector(vec []float32) string {
	buf := make([]byte, len(vec)*4)
	for i, v := range vec {
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(v))
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

// decodeVector decodes a base64 string back to a float32 slice.
func decodeVector(s string) []float32 {
	buf, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(buf) == 0 || len(buf)%4 != 0 {
		return nil
	}
	vec := make([]float32, len(buf)/4)
	for i := range vec {
		vec[i] = math.Float32frombits(binary.LittleEndian.Uint32(buf[i*4:]))
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

	st, err := store.OpenDefaultCached()
	if err != nil {
		return nil
	}

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
