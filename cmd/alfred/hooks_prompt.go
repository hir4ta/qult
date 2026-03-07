package main

import (
	"fmt"
	"sort"
	"strings"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// ---------------------------------------------------------------------------
// PreToolUse: .claude/ config access reminder
// ---------------------------------------------------------------------------

// isClaudeConfigPath reports whether path refers to a Claude Code configuration
// file or directory (.claude/, CLAUDE.md, MEMORY.md, .mcp.json).
func isClaudeConfigPath(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, ".claude/") ||
		strings.Contains(lower, "claude.md") ||
		strings.Contains(lower, "memory.md") ||
		strings.Contains(lower, ".mcp.json")
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
func handlePreToolUse(ev *hookEvent) {
	if !shouldRemind(ev.ToolInput) {
		return
	}
	debugf("PreToolUse: reminding about alfred for %v", ev.ToolInput)
	fmt.Print(configReminder)
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

// domainSynonyms maps user terms to related knowledge base terms for query expansion.
var domainSynonyms = map[string][]string{
	"hook":        {"hooks", "lifecycle", "event handler", "PreToolUse", "SessionStart", "PreCompact"},
	"hooks":       {"hook", "lifecycle", "event handler"},
	"mcp":         {"model context protocol", "tool server", "MCP server"},
	"compact":     {"compaction", "context window", "token limit", "PreCompact"},
	"compaction":  {"compact", "context window", "PreCompact"},
	"rule":        {"rules", "instructions", "glob patterns"},
	"rules":       {"rule", "instructions", "glob patterns"},
	"skill":       {"skills", "slash command", "SKILL.md"},
	"skills":      {"skill", "slash command", "SKILL.md"},
	"memory":      {"MEMORY.md", "auto memory", "persistence", "context"},
	"agent":       {"agents", "subagent", "custom agent"},
	"agents":      {"agent", "subagent", "custom agent"},
	"config":      {"configuration", "CLAUDE.md", ".claude/", "settings"},
	"configure":   {"configuration", "CLAUDE.md", ".claude/", "setup"},
	"setup":       {"configure", "initialize", "wizard"},
	"worktree":    {"worktrees", "git worktree", "isolation"},
	"review":      {"code review", "audit", "inspect"},
	"spec":        {"specification", "butler protocol", "requirements"},
	"embed":       {"embedding", "vector", "semantic search"},
	"embedding":   {"embed", "vector", "semantic search"},
	"search":      {"FTS", "full text search", "vector search", "hybrid"},
	"test":        {"testing", "test runner"},
	"debug":       {"debugging", "troubleshoot", "ALFRED_DEBUG"},
	"permission":  {"permissions", "allowed tools", "security"},
	"permissions": {"permission", "allowed tools", "security"},
}

// claudeCodeKeywords are terms indicating a prompt is about Claude Code features.
// Proactive knowledge injection only fires when these are detected.
var claudeCodeKeywords = []string{
	// English — multi-word or specific enough to avoid false positives.
	"hook", "hooks", "skill", "skills",
	"subagent", "mcp", "claude.md",
	"memory.md", "claude code", "compact", "compaction",
	"plugin", "worktree", "slash command", "claude-code",
	"settings.json", "frontmatter",
	// Japanese — specific to Claude Code context.
	"フック", "スキル", "ルール", "エージェント",
	"プラグイン", "設定ファイル", "コンパクト",
}

// claudeCodeKeywordsLower is the pre-lowered version of claudeCodeKeywords.
// Japanese keywords are unaffected by ToLower but included for consistency.
var claudeCodeKeywordsLower = func() []string {
	out := make([]string, len(claudeCodeKeywords))
	for i, kw := range claudeCodeKeywords {
		out[i] = strings.ToLower(kw)
	}
	return out
}()

// isClaudeCodeRelated reports whether the prompt mentions Claude Code features.
func isClaudeCodeRelated(prompt string) bool {
	lower := strings.ToLower(prompt)
	for _, kw := range claudeCodeKeywordsLower {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

// expandQuery adds domain synonyms to a keyword query for better FTS recall.
func expandQuery(keywords string) string {
	words := strings.Fields(keywords)
	var expanded []string
	expanded = append(expanded, words...)
	for _, w := range words {
		if syns, ok := domainSynonyms[strings.ToLower(w)]; ok {
			// Add up to 2 synonyms to avoid overly broad queries.
			for i, s := range syns {
				if i >= 2 {
					break
				}
				expanded = append(expanded, s)
			}
		}
	}
	return strings.Join(expanded, " ")
}

// extractSearchKeywords extracts meaningful keywords from a prompt for FTS search.
// Filters out common stop words and short words, returns up to maxWords.
func extractSearchKeywords(prompt string, maxWords int) string {
	stopWords := map[string]bool{
		"the": true, "a": true, "an": true, "is": true, "are": true,
		"was": true, "were": true, "be": true, "been": true, "being": true,
		"have": true, "has": true, "had": true, "do": true, "does": true,
		"did": true, "will": true, "would": true, "could": true, "should": true,
		"may": true, "might": true, "can": true, "this": true, "that": true,
		"these": true, "those": true, "with": true, "from": true, "into": true,
		"for": true, "and": true, "but": true, "not": true, "what": true,
		"how": true, "when": true, "where": true, "which": true, "who": true,
		"about": true, "some": true, "want": true, "need": true, "like": true,
		"make": true, "just": true, "also": true, "more": true, "very": true,
		"please": true, "help": true, "using": true, "used": true, "use": true,
	}

	var keywords []string
	for _, word := range strings.Fields(strings.ToLower(prompt)) {
		// Strip punctuation.
		word = strings.Trim(word, ".,!?;:\"'`()[]{}/-")
		if len(word) < 3 || stopWords[word] {
			continue
		}
		keywords = append(keywords, word)
		if len(keywords) >= maxWords {
			break
		}
	}
	return strings.Join(keywords, " ")
}

// scoreRelevance computes a relevance score (0.0-1.0) between a prompt and a document.
// Uses section_path matching, content keyword overlap with position weighting,
// and coverage bonus for multiple distinct keyword matches.
func scoreRelevance(promptLower string, doc store.DocRow) float64 {
	promptWords := strings.Fields(promptLower)
	if len(promptWords) == 0 {
		return 0
	}

	// Filter to meaningful words (4+ chars, not stop words).
	var meaningful []string
	for _, w := range promptWords {
		if len(w) >= 4 {
			meaningful = append(meaningful, w)
		}
	}
	if len(meaningful) == 0 {
		return 0
	}

	// Section path match: high value signal.
	pathLower := strings.ToLower(doc.SectionPath)
	pathHits := 0
	for _, w := range meaningful {
		if strings.Contains(pathLower, w) {
			pathHits++
		}
	}
	pathScore := float64(pathHits) * 0.25

	// Content match with position weighting.
	contentLower := strings.ToLower(doc.Content)
	firstLine := contentLower
	if idx := strings.IndexByte(firstLine, '\n'); idx > 0 {
		firstLine = firstLine[:idx]
	}

	contentHits := 0
	earlyHits := 0 // matches in first line get bonus
	for _, w := range meaningful {
		if strings.Contains(contentLower, w) {
			contentHits++
			if strings.Contains(firstLine, w) {
				earlyHits++
			}
		}
	}

	coverage := float64(contentHits) / float64(len(meaningful))
	earlyBonus := float64(earlyHits) * 0.1

	// Coverage bonus: reward matching multiple distinct keywords.
	coverageBonus := 0.0
	if contentHits >= 3 {
		coverageBonus = 0.15
	} else if contentHits >= 2 {
		coverageBonus = 0.05
	}

	return min(pathScore+coverage+earlyBonus+coverageBonus, 1.0)
}

// handleUserPromptSubmit emits config reminders and proactively injects
// relevant knowledge from the FTS index based on the user's prompt.
func handleUserPromptSubmit(ev *hookEvent) {
	if shouldRemindPrompt(ev.Prompt) {
		debugf("UserPromptSubmit: reminding about alfred for prompt")
		fmt.Print(configReminder)
		return // config reminder is sufficient, skip knowledge injection
	}

	// Proactive knowledge injection: only when prompt relates to Claude Code features.
	prompt := strings.TrimSpace(ev.Prompt)
	if !isClaudeCodeRelated(prompt) {
		return
	}
	if len([]rune(prompt)) < 10 {
		return // too short to search meaningfully (rune-based for CJK)
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		debugf("UserPromptSubmit: store open failed: %v", err)
		return
	}

	// Strategy 1: Search with extracted keywords + synonym expansion.
	keywords := extractSearchKeywords(prompt, 8)
	var allDocs []store.DocRow

	if keywords != "" {
		expanded := expandQuery(keywords)
		docs, err := st.SearchDocsFTS(expanded, "", 5)
		if err == nil {
			allDocs = append(allDocs, docs...)
		}
	}

	// Strategy 2: Search with raw prompt (catches phrase matches).
	rawQuery := prompt
	if len(rawQuery) > 150 {
		rawQuery = rawQuery[:150]
	}
	docs, err := st.SearchDocsFTS(rawQuery, "", 3)
	if err == nil {
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

	// Score and filter by relevance.
	promptLower := strings.ToLower(prompt)
	type scored struct {
		doc   store.DocRow
		score float64
	}
	var candidates []scored
	for _, doc := range uniqueDocs {
		s := scoreRelevance(promptLower, doc)
		if s >= 0.40 {
			candidates = append(candidates, scored{doc, s})
		}
	}
	if len(candidates) == 0 {
		debugf("UserPromptSubmit: no relevant matches (all below threshold)")
		return
	}

	// Sort by score descending, take top 2.
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].score > candidates[j].score
	})
	if len(candidates) > 2 {
		candidates = candidates[:2]
	}

	var buf strings.Builder
	buf.WriteString("Relevant best practices from alfred knowledge base:\n")
	for _, c := range candidates {
		snippet := c.doc.Content
		if len(snippet) > 300 {
			snippet = snippet[:300] + "..."
		}
		fmt.Fprintf(&buf, "- [%s] %s\n", c.doc.SectionPath, snippet)
	}
	fmt.Print(buf.String())
	debugf("UserPromptSubmit: injected %d knowledge snippets (scores: %.2f+)", len(candidates), candidates[0].score)
}
