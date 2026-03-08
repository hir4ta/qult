package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// openStore is the function used to obtain a store connection.
// Overridable in tests.
var openStore = func() (*store.Store, error) {
	return store.OpenDefaultCached()
}

// Scoring thresholds for knowledge injection.
// Defaults can be overridden via environment variables for tuning.
var (
	relevanceThreshold      = envFloat("ALFRED_RELEVANCE_THRESHOLD", 0.40)
	highConfidenceThreshold = envFloat("ALFRED_HIGH_CONFIDENCE_THRESHOLD", 0.65)
	singleKeywordDampen     = envFloat("ALFRED_SINGLE_KEYWORD_DAMPEN", 0.8)
)

// Scoring weights for keyword-aware relevance computation.
const (
	kwPathWeight    = 0.40 // weight for keyword hits in doc section path
	kwContentWeight = 0.20 // weight for keyword hits in doc content
	coverageWeight  = 0.30 // weight for prompt token coverage in doc
	earlyBonus      = 0.05 // bonus per early (first-line) hit
)

// envFloat returns the environment variable as float64 or the default value.
func envFloat(key string, defaultVal float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return defaultVal
}

// ---------------------------------------------------------------------------
// Architecture note: Hook vs MCP knowledge injection
//
// UserPromptSubmit hook (this file):
//   - Passive/proactive: fires automatically on every prompt
//   - Lightweight: FTS5 only, no Voyage API calls
//   - Scope: injects up to 2 short snippets (300 chars each)
//   - Purpose: surface relevant context BEFORE Claude starts working
//
// MCP "knowledge" tool (mcpserver/handlers_search.go):
//   - Active: called explicitly by Claude or user
//   - Heavyweight: hybrid vector + FTS5 + Voyage rerank
//   - Scope: returns full search results with scores
//   - Purpose: deep research when Claude needs detailed information
//
// These are complementary, not redundant. The hook primes Claude with
// lightweight hints; the MCP tool provides deep answers on demand.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PreToolUse: .claude/ config access reminder
// ---------------------------------------------------------------------------

// isClaudeConfigPath reports whether path refers to a Claude Code configuration
// file or directory (.claude/, CLAUDE.md, MEMORY.md, .mcp.json).
// Uses suffix/segment matching to avoid false positives on paths like "myclaude.md".
func isClaudeConfigPath(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, ".claude/") ||
		strings.HasSuffix(lower, "/claude.md") || lower == "claude.md" ||
		strings.HasSuffix(lower, "/memory.md") || lower == "memory.md" ||
		strings.HasSuffix(lower, "/.mcp.json") || lower == ".mcp.json"
}

// shouldRemind reports whether a tool's input targets Claude Code configuration.
// Checks file_path (Read/Edit/Write), path (Grep/Glob), and pattern (Glob).
func shouldRemind(toolInput map[string]any) bool {
	for _, key := range []string{"file_path", "path", "pattern"} {
		if v, ok := toolInput[key]; ok {
			if s, ok := v.(string); ok && s != "" {
				if isClaudeConfigPath(s) {
					return true
				}
			}
		}
	}
	return false
}

// handlePreToolUse emits a reminder when Claude accesses .claude/ config files.
// Uses hookSpecificOutput with permissionDecision "allow" to inject the reminder
// as feedback while letting the tool call proceed.
func handlePreToolUse(ev *hookEvent) {
	if len(ev.ToolInput) == 0 {
		return
	}
	if !shouldRemind(ev.ToolInput) {
		return
	}
	debugf("PreToolUse: reminding about alfred for %v", ev.ToolInput)
	out := map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":            "PreToolUse",
			"permissionDecision":       "allow",
			"permissionDecisionReason": configReminder,
		},
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		debugf("PreToolUse: json encode error: %v", err)
	}
}

// ---------------------------------------------------------------------------
// UserPromptSubmit: Claude Code config keyword detection + knowledge injection
// ---------------------------------------------------------------------------

// shouldRemindPrompt reports whether the user's prompt mentions Claude Code
// configuration paths (.claude, CLAUDE.md, MEMORY.md, .mcp.json).
func shouldRemindPrompt(prompt string) bool {
	lower := strings.ToLower(prompt)
	for _, term := range []string{".claude", "claude.md", "memory.md", ".mcp.json"} {
		if strings.Contains(lower, term) {
			return true
		}
	}
	return false
}

// scoreRelevance computes a relevance score (0.0-1.0) for injecting a document.
//
// Two-signal design:
//   - Primary signal: matched Claude Code keywords in doc path/content (high weight)
//   - Secondary signal: prompt content token coverage in doc (bonus)
//
// Single-keyword matches are dampened (×0.7) to require content coverage for injection.
// This prevents generic docs from being injected when the prompt merely mentions a keyword
// without actually asking about that topic.
//
// matchedKeywords are the Claude Code keywords detected in the prompt by Gate 1.
// promptLower is the full prompt (lowercased) for secondary coverage scoring.
func scoreRelevance(matchedKeywords []string, promptLower string, doc store.DocRow) float64 {
	pathLower := strings.ToLower(doc.SectionPath)
	contentLower := strings.ToLower(doc.Content)
	firstLine := contentLower
	if idx := strings.IndexByte(firstLine, '\n'); idx > 0 {
		firstLine = firstLine[:idx]
	}

	// Primary signal: matched Claude Code keywords in doc.
	// For katakana keywords, also check their English equivalents against the English KB.
	kwPathHits := 0
	kwContentHits := 0
	for _, kw := range matchedKeywords {
		kwCheck := kw
		if en, ok := store.KatakanaToEnglish[kw]; ok {
			kwCheck = en
		}
		if strings.Contains(pathLower, kwCheck) {
			kwPathHits++
		}
		if strings.Contains(contentLower, kwCheck) {
			kwContentHits++
		}
	}
	nkw := max(len(matchedKeywords), 1)
	keywordScore := float64(kwPathHits)*kwPathWeight/float64(nkw) + float64(kwContentHits)*kwContentWeight/float64(nkw)

	// Dampen single-keyword confidence: one keyword alone is weak signal.
	if len(matchedKeywords) == 1 {
		keywordScore *= singleKeywordDampen
	}

	// Secondary signal: content token coverage in doc.
	// Uses POS-filtered tokens with base forms for better cross-lingual matching.
	meaningful := contentTokensForScoring(promptLower)

	contentHits := 0
	earlyHits := 0
	for _, w := range meaningful {
		if strings.Contains(contentLower, w) {
			contentHits++
			if strings.Contains(firstLine, w) {
				earlyHits++
			}
		}
	}

	coverageScore := 0.0
	if len(meaningful) > 0 {
		coverageScore = float64(contentHits) / float64(len(meaningful)) * coverageWeight
	}
	earlyScore := float64(earlyHits) * earlyBonus

	return min(keywordScore+coverageScore+earlyScore, 1.0)
}

// handleUserPromptSubmit emits config reminders and proactively injects
// relevant knowledge from the FTS index based on the user's prompt.
//
// Precision design (v4):
// 1. Detect Claude Code keywords with word boundary + framework negation (Gate 1)
// 2. Search FTS using ONLY matched keywords — no synonym expansion (Gate 2)
// 3. Score with kagome tokenizer + keyword-aware relevance, threshold 0.40 (Gate 3)
//    Single-keyword matches dampened (×0.7) to require content coverage
// 4. Inject 1 result by default; 2 only if top score >= 0.65
func handleUserPromptSubmit(_ context.Context, ev *hookEvent) {
	if shouldRemindPrompt(ev.Prompt) {
		debugf("UserPromptSubmit: reminding about alfred for prompt")
		emitAdditionalContext("UserPromptSubmit", configReminder)
		return // config reminder is sufficient, skip knowledge injection
	}

	prompt := strings.TrimSpace(ev.Prompt)
	if len([]rune(prompt)) < 10 {
		return // too short to search meaningfully (rune-based for CJK)
	}

	// Gate 1: Detect Claude Code keywords with word boundary matching.
	// Only the matched keywords are used as search terms — no synonym expansion.
	matched := detectClaudeCodeKeywords(prompt)
	if len(matched) == 0 {
		debugf("UserPromptSubmit: no Claude Code keywords detected, skipping")
		return
	}

	st, err := openStore()
	if err != nil {
		debugf("UserPromptSubmit: store open failed: %v", err)
		return
	}

	// Gate 2: Search FTS using matched Claude Code keywords only.
	// Translate katakana keywords to English for searching the English KB.
	var ftsTerms []string
	for _, kw := range matched {
		if en, ok := store.KatakanaToEnglish[kw]; ok {
			ftsTerms = append(ftsTerms, en)
		} else {
			ftsTerms = append(ftsTerms, kw)
		}
	}
	ftsQuery := strings.Join(ftsTerms, " OR ")
	// Retrieve 8 candidates: enough diversity for scoring, but bounded to keep hook fast.
	allDocs, ftsErr := st.SearchDocsFTS(ftsQuery, "docs", 8)
	if ftsErr != nil {
		debugf("UserPromptSubmit: FTS keyword search failed: %v", ftsErr)
	}

	// Supplemental: also search with prompt keywords (no expansion) for coverage.
	keywords := extractSearchKeywords(prompt, 6)
	if keywords != "" {
		docs, err := st.SearchDocsFTS(keywords, "docs", 3)
		if err != nil {
			debugf("UserPromptSubmit: FTS supplemental search failed: %v", err)
		}
		allDocs = append(allDocs, docs...)
	}

	if len(allDocs) == 0 {
		debugf("UserPromptSubmit: FTS search returned 0 results")
		return
	}

	// Deduplicate by doc ID.
	seen := make(map[int64]bool)
	var uniqueDocs []store.DocRow
	for _, d := range allDocs {
		if !seen[d.ID] {
			seen[d.ID] = true
			uniqueDocs = append(uniqueDocs, d)
		}
	}

	// Gate 3: Score with keyword-aware relevance (primary: keywords in doc, secondary: prompt coverage).
	promptLower := strings.ToLower(prompt)
	type scored struct {
		doc   store.DocRow
		score float64
	}
	var candidates []scored
	for _, doc := range uniqueDocs {
		s := scoreRelevance(matched, promptLower, doc)
		if s >= relevanceThreshold {
			candidates = append(candidates, scored{doc, s})
		}
	}
	if len(candidates) == 0 {
		debugf("UserPromptSubmit: no relevant matches (all below %.2f threshold)", relevanceThreshold)
		return
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].score > candidates[j].score
	})

	// Confidence-based injection: 1 result by default, 2 if top score is high.
	maxResults := 1
	if len(candidates) > 1 && candidates[0].score >= highConfidenceThreshold {
		maxResults = 2
	}
	if len(candidates) > maxResults {
		candidates = candidates[:maxResults]
	}

	var buf strings.Builder
	buf.WriteString("Relevant best practices from alfred knowledge base:\n")
	for _, c := range candidates {
		snippet := safeSnippet(c.doc.Content, 300)
		fmt.Fprintf(&buf, "- [%s] %s\n", c.doc.SectionPath, snippet)
	}
	// Also search memories (no keyword gate — memory is small).
	memSnippets := searchMemoryForPrompt(prompt, st)
	if len(memSnippets) > 0 {
		buf.WriteString("\nRelated past experience:\n")
		for _, m := range memSnippets {
			buf.WriteString(m)
		}
	}

	emitAdditionalContext("UserPromptSubmit", buf.String())
	debugf("UserPromptSubmit: injected %d knowledge snippets (top score: %.2f, keywords: %v), %d memory hints", len(candidates), candidates[0].score, matched, len(memSnippets))
}

// searchMemoryForPrompt searches memory docs for the user's prompt.
// Returns formatted snippet lines (max 2) or nil if no relevant memories found.
func searchMemoryForPrompt(prompt string, st *store.Store) []string {
	keywords := extractSearchKeywords(prompt, 6)
	if keywords == "" {
		return nil
	}

	docs, err := st.SearchDocsFTS(keywords, "memory", 2)
	if err != nil || len(docs) == 0 {
		return nil
	}

	var results []string
	for _, d := range docs {
		snippet := safeSnippet(d.Content, 200)
		results = append(results, fmt.Sprintf("- [%s] %s\n", d.SectionPath, snippet))
	}
	debugf("UserPromptSubmit: memory search found %d results for keywords=%s", len(results), keywords)
	return results
}
