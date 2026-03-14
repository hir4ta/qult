package main

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// openStore is the function used to obtain a store connection.
// Overridable in tests.
var openStore = func() (*store.Store, error) {
	return store.OpenDefaultCached()
}

// Default scoring thresholds for knowledge injection.
// Overridden by: .alfred/config.json (project) > environment variable > default.
const (
	defaultRelevanceThreshold      = 0.40
	defaultHighConfidenceThreshold = 0.65
	defaultSingleKeywordDampen     = 0.80
)

// Scoring weights for keyword-aware relevance computation.
const (
	kwPathWeight    = 0.40 // weight for keyword hits in doc section path
	kwContentWeight = 0.20 // weight for keyword hits in doc content
	coverageWeight  = 0.30 // weight for prompt token coverage in doc
	earlyBonus      = 0.05 // bonus per early (first-line) hit
)

// scored pairs a document with its relevance score.
type scored struct {
	doc   store.DocRow
	score float64
}

// envFloat returns the environment variable as float64 or the default value.
func envFloat(key string, defaultVal float64) float64 {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		debugf("envFloat: invalid %s=%q, using default %v", key, v, defaultVal)
		return defaultVal
	}
	if f < 0 || f > 1 {
		debugf("envFloat: %s=%v out of range [0,1], clamping", key, f)
		return max(0, min(1, f))
	}
	return f
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
// Single-keyword matches are dampened to require content coverage for injection.
// This prevents generic docs from being injected when the prompt merely mentions a keyword
// without actually asking about that topic.
//
// matchedKeywords are the Claude Code keywords detected in the prompt by Gate 1.
// promptLower is the full prompt (lowercased) for secondary coverage scoring.
// dampen is the single-keyword dampening factor.
func scoreRelevance(matchedKeywords []string, promptLower string, doc store.DocRow, dampen float64) float64 {
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
		if en, ok := store.TranslateTerm(kw); ok {
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
		keywordScore *= dampen
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
func handleUserPromptSubmit(ctx context.Context, ev *hookEvent) {
	// Resolve per-project thresholds: .alfred/config.json > env var > default.
	cfg := loadProjectConfig(ev.ProjectPath)
	var quietPtr *bool
	var relPtr, highPtr, dampenPtr *float64
	if cfg != nil {
		quietPtr = cfg.Quiet
		relPtr = cfg.RelevanceThreshold
		highPtr = cfg.HighConfidenceThreshold
		dampenPtr = cfg.SingleKeywordDampen
	}

	// Quiet mode: suppress knowledge injection (spec recovery & session persistence still run).
	if resolveBool(quietPtr, "ALFRED_QUIET") {
		debugf("UserPromptSubmit: quiet mode, skipping")
		return
	}

	relevanceThreshold := resolveFloat(relPtr, "ALFRED_RELEVANCE_THRESHOLD", defaultRelevanceThreshold)
	highConfidenceThreshold := resolveFloat(highPtr, "ALFRED_HIGH_CONFIDENCE_THRESHOLD", defaultHighConfidenceThreshold)
	skDampen := resolveFloat(dampenPtr, "ALFRED_SINGLE_KEYWORD_DAMPEN", defaultSingleKeywordDampen)

	if shouldRemindPrompt(ev.Prompt) {
		debugf("UserPromptSubmit: reminding about alfred for prompt")
		emitAdditionalContext("UserPromptSubmit", configReminder)
		return // config reminder is sufficient, skip knowledge injection
	}

	prompt := strings.TrimSpace(ev.Prompt)
	if len([]rune(prompt)) < 10 {
		return // too short to search meaningfully (rune-based for CJK)
	}

	// Detect workflow opportunities and suggest skills proactively.
	workflowHint := detectWorkflowOpportunity(prompt, ev.ProjectPath)

	// Check context pressure.
	if ctxHint := estimateContextPressure(ev); ctxHint != "" {
		if workflowHint != "" {
			workflowHint += "\n\n" + ctxHint
		} else {
			workflowHint = ctxHint
		}
	}

	// Detect "remember this" intent for recall tool suggestion.
	rememberHint := ""
	if detectRememberIntent(prompt) {
		debugf("UserPromptSubmit: remember intent detected")
		rememberHint = "User wants to save information. Use the recall tool with action=save to persist this as permanent memory. " +
			"Parameters: content (what to save), label (short description), project (optional context)."
	}

	// Load spec/session context for proactive knowledge push (non-blocking).
	var specCtx *specContext
	var ctxBoostDisable *bool
	if cfg != nil {
		ctxBoostDisable = cfg.ContextBoostDisable
	}
	if !resolveBool(ctxBoostDisable, "ALFRED_CONTEXT_BOOST_DISABLE") {
		specCtx = loadSpecContext(ev.ProjectPath)
	}

	// Gate 1: Detect Claude Code keywords with word boundary matching.
	// Only the matched keywords are used as search terms — no synonym expansion.
	matched := detectClaudeCodeKeywords(prompt)
	if len(matched) == 0 {
		hints := workflowHint
		if rememberHint != "" {
			if hints != "" {
				hints += "\n\n"
			}
			hints += rememberHint
		}
		if hints != "" {
			emitAdditionalContext("UserPromptSubmit", hints)
		}
		debugf("UserPromptSubmit: no Claude Code keywords detected, skipping")
		return
	}

	st, err := openStore()
	if err != nil {
		notifyUser("warning: knowledge search unavailable: %v", err)
		debugf("UserPromptSubmit: store open failed: %v", err)
		return
	}

	// Gate 2: Search FTS using matched Claude Code keywords only.
	// Translate katakana keywords to English for searching the English KB.
	var ftsTerms []string
	for _, kw := range matched {
		if en, ok := store.TranslateTerm(kw); ok {
			ftsTerms = append(ftsTerms, en)
		} else {
			ftsTerms = append(ftsTerms, kw)
		}
	}
	ftsQuery := store.JoinFTS5Terms(ftsTerms)
	// Retrieve 8 candidates: enough diversity for scoring, but bounded to keep hook fast.
	allDocs, ftsErr := st.SearchDocsFTS(ctx, ftsQuery, store.SourceDocs, 8)
	if ftsErr != nil {
		debugf("UserPromptSubmit: FTS keyword search failed: %v", ftsErr)
	}

	// Supplemental: also search with prompt keywords (no expansion) for coverage.
	// Skip if context deadline already exceeded — use whatever we have.
	if ctx.Err() == nil {
		keywords := extractSearchKeywords(prompt, 6)
		if keywords != "" {
			docs, err := st.SearchDocsFTS(ctx, keywords, store.SourceDocs, 3)
			if err != nil {
				debugf("UserPromptSubmit: FTS supplemental search failed: %v", err)
			}
			allDocs = append(allDocs, docs...)
		}
	} else {
		debugf("UserPromptSubmit: skipping supplemental search (timeout)")
	}

	// Proactive knowledge push: search with spec/session context keywords.
	if specCtx != nil && ctx.Err() == nil {
		ctxDocs := searchSpecContext(ctx, specCtx, st)
		allDocs = append(allDocs, ctxDocs...)
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
	var candidates []scored
	for _, doc := range uniqueDocs {
		s := scoreRelevance(matched, promptLower, doc, skDampen)
		if s >= relevanceThreshold {
			candidates = append(candidates, scored{doc, s})
		}
	}
	if len(candidates) == 0 {
		debugf("UserPromptSubmit: no relevant matches (all below %.2f threshold)", relevanceThreshold)
		return
	}

	// Implicit feedback: check if previous injection's topic was referenced in this prompt.
	// Skip on timeout — scoring results is more valuable than feedback tracking.
	if ctx.Err() == nil {
		evaluateInjectionFeedback(ctx, prompt, st)
	}

	// Apply feedback boost BEFORE maxResults selection so boosted docs
	// can be promoted into the top results.
	boostIDs := make([]int64, len(candidates))
	for i := range candidates {
		boostIDs[i] = candidates[i].doc.ID
	}
	boosts := st.FeedbackBoostBatch(ctx, boostIDs)
	for i := range candidates {
		if b, ok := boosts[candidates[i].doc.ID]; ok {
			// Additive boost: b is 1.0 ± ratio*0.1, so (b - 1.0) gives ±0.1 range.
			// No floor at 0 — let the threshold filter handle exclusion symmetrically
			// for both boosted and penalized docs.
			candidates[i].score += b - 1.0
		}
	}

	// Apply spec/session context boost (post-scoring, tiebreaker semantics).
	ctxBoostedIDs := applyContextBoost(candidates, specCtx)
	if len(ctxBoostedIDs) > 0 {
		debugf("UserPromptSubmit: context boost applied to %d candidates", len(ctxBoostedIDs))
	}

	// Re-sort after boost and re-apply threshold.
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].score > candidates[j].score
	})
	var filtered []scored
	for _, c := range candidates {
		if c.score >= relevanceThreshold {
			filtered = append(filtered, c)
		}
	}
	candidates = filtered
	if len(candidates) == 0 {
		debugf("UserPromptSubmit: no relevant matches after feedback boost")
		return
	}

	// Confidence-based injection: 1 result by default, 2 if top score is high.
	maxResults := 1
	if len(candidates) > 1 && candidates[0].score >= highConfidenceThreshold {
		maxResults = 2
	}
	if len(candidates) > maxResults {
		candidates = candidates[:maxResults]
	}

	var buf strings.Builder
	if workflowHint != "" {
		buf.WriteString(workflowHint + "\n\n")
	}
	if rememberHint != "" {
		buf.WriteString(rememberHint + "\n\n")
	}

	// Separate context-boosted results from regular keyword-matched results.
	var regular, contextAware []scored
	for _, c := range candidates {
		if ctxBoostedIDs[c.doc.ID] {
			contextAware = append(contextAware, c)
		} else {
			regular = append(regular, c)
		}
	}
	if len(regular) > 0 {
		buf.WriteString("Relevant best practices from alfred knowledge base:\n")
		for _, c := range regular {
			snippet := safeSnippet(c.doc.Content, 300)
			fmt.Fprintf(&buf, "- [%s] %s\n", c.doc.SectionPath, snippet)
		}
	}
	if len(contextAware) > 0 {
		if len(regular) > 0 {
			buf.WriteByte('\n')
		}
		buf.WriteString("Context-aware suggestions (based on current task):\n")
		for _, c := range contextAware {
			snippet := safeSnippet(c.doc.Content, 300)
			fmt.Fprintf(&buf, "- [%s] %s\n", c.doc.SectionPath, snippet)
		}
	}
	// Also search memories (no keyword gate — memory is small).
	memSnippets := searchMemoryForPrompt(ctx, prompt, st)
	if len(memSnippets) > 0 {
		buf.WriteString("\nRelated past experience:\n")
		for _, m := range memSnippets {
			buf.WriteString(m)
		}
	}

	// Search and inject relevant instincts (learned behavioral patterns).
	instinctSnippets := searchRelevantInstincts(ctx, prompt, ev.ProjectPath, st)
	if len(instinctSnippets) > 0 {
		buf.WriteString("\nLearned patterns from past sessions:\n")
		for _, s := range instinctSnippets {
			buf.WriteString(s)
		}
	}

	// Record which docs were injected for feedback tracking.
	var injectedIDs []int64
	for _, c := range candidates {
		injectedIDs = append(injectedIDs, c.doc.ID)
	}
	if err := st.RecordInjection(ctx, injectedIDs); err != nil {
		debugf("UserPromptSubmit: record injection error: %v", err)
	}

	emitAdditionalContext("UserPromptSubmit", buf.String())
	if len(candidates) == 1 {
		notifyUser("injected 1 knowledge snippet (score: %.2f, keywords: %v)",
			candidates[0].score, matched)
	} else {
		notifyUser("injected %d knowledge snippets (scores: %.2f, %.2f; keywords: %v)",
			len(candidates), candidates[0].score, candidates[1].score, matched)
	}
	debugf("UserPromptSubmit: injected %d knowledge snippets (top score: %.2f, keywords: %v), %d memory hints", len(candidates), candidates[0].score, matched, len(memSnippets))
}

// rememberKeywords are phrases indicating the user wants to save information.
var rememberKeywords = []string{
	"覚えて", "覚えておいて", "記憶して", "記憶しておいて",
	"メモして", "メモしておいて",
	"remember this", "remember that", "save this", "save that",
	"don't forget",
}

// detectRememberIntent returns true if the prompt contains a "remember this" keyword.
func detectRememberIntent(prompt string) bool {
	lower := strings.ToLower(prompt)
	for _, kw := range rememberKeywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

// evaluateInjectionFeedback checks if docs injected in the previous prompt
// are referenced in the current prompt (implicit positive signal).
// Uses a 10-minute window to capture multi-turn conversations.
func evaluateInjectionFeedback(ctx context.Context, prompt string, st *store.Store) {
	recentIDs, err := st.GetRecentInjections(ctx, 10*time.Minute)
	if err != nil || len(recentIDs) == 0 {
		return
	}

	// Load the injected docs and check if their topics appear in the current prompt.
	docs, err := st.GetDocsByIDs(ctx, recentIDs)
	if err != nil || len(docs) == 0 {
		return
	}

	promptLower := strings.ToLower(prompt)
	// Skip negative feedback for very short prompts (e.g., "ok", "continue", "はい").
	// Short prompts can't plausibly reference injected topics, so absence of
	// overlap is not a meaningful negative signal.
	promptWords := strings.Fields(promptLower)
	shortPrompt := len(promptWords) < 5

	for _, doc := range docs {
		// Extract significant words from the doc's section path.
		pathWords := strings.Fields(strings.ToLower(doc.SectionPath))
		hits := 0
		meaningful := 0
		for _, w := range pathWords {
			w = strings.Trim(w, ">|")
			if len(w) >= 3 {
				meaningful++
				if strings.Contains(promptLower, w) {
					hits++
				}
			}
		}
		if meaningful == 0 {
			continue
		}
		positive := float64(hits)/float64(meaningful) >= 0.3
		if positive {
			if err := st.RecordFeedback(ctx, doc.ID, true); err != nil {
				debugf("evaluateInjectionFeedback: positive feedback error: %v", err)
			}
		} else if !shortPrompt {
			// Only record negative feedback for substantive prompts.
			if err := st.RecordFeedback(ctx, doc.ID, false); err != nil {
				debugf("evaluateInjectionFeedback: negative feedback error: %v", err)
			}
		}
	}
}

// searchMemoryForPrompt searches memory docs for the user's prompt.
// Returns formatted snippet lines (max 2) or nil if no relevant memories found.
func searchMemoryForPrompt(ctx context.Context, prompt string, st *store.Store) []string {
	keywords := extractSearchKeywords(prompt, 6)
	if keywords == "" {
		return nil
	}

	docs, err := st.SearchDocsFTS(ctx, keywords, store.SourceMemory, 2)
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
