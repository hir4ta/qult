package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"unicode"

	"github.com/ikawaha/kagome-dict/ipa"
	"github.com/ikawaha/kagome/v2/tokenizer"
	"github.com/kljensen/snowball"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// openStore is the function used to obtain a store connection.
// Overridable in tests.
var openStore = func() (*store.Store, error) {
	return store.OpenDefaultCached()
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
	json.NewEncoder(os.Stdout).Encode(out)
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


// claudeCodeKeywords are terms indicating a prompt is about Claude Code features.
// Proactive knowledge injection only fires when these are detected.
var claudeCodeKeywords = []string{
	// English
	"hook", "hooks", "skill", "skills",
	"rule", "rules", "subagent", "mcp", "claude.md",
	"memory.md", "claude code", "compact", "compaction",
	"plugin", "worktree", "slash command", "claude-code",
	"settings.json", "frontmatter", "permission",
	// Hook event names (unambiguous)
	"pretooluse", "sessionstart", "precompact", "userpromptsubmit",
	// Japanese — specific to Claude Code context.
	"フック", "スキル", "ルール", "エージェント",
	"プラグイン", "設定ファイル", "コンパクト",
}

// katakanaToEnglish maps Japanese katakana Claude Code terms to their English equivalents.
// Used to translate FTS queries so Japanese keywords find English documents.
var katakanaToEnglish = map[string]string{
	"フック":    "hook",
	"スキル":    "skill",
	"ルール":    "rule",
	"エージェント": "agent",
	"プラグイン":  "plugin",
	"コンパクト":  "compact",
	"設定ファイル": "settings",
}

// ambiguousKeywords maps keywords that are shared with other frameworks
// to framework identifiers that negate the Claude Code interpretation.
// Only well-known framework names are listed — not features or concepts.
var ambiguousKeywords = map[string][]string{
	"hook":       {"react", "vue", "angular", "svelte", "wordpress", "pre-commit", "pre-push", "post-commit"},
	"hooks":      {"react", "vue", "angular", "svelte", "wordpress", "pre-commit", "pre-push", "post-commit"},
	"フック":        {"react", "vue", "angular", "svelte", "wordpress", "pre-commit", "pre-push", "post-commit", "git hook"},
	"plugin":     {"webpack", "vite", "rollup", "babel", "eslint", "vim", "neovim", "wordpress", "jquery", "gradle", "maven"},
	"プラグイン":      {"webpack", "vite", "rollup", "babel", "eslint", "vim", "neovim", "wordpress", "jquery", "gradle", "maven"},
	"rule":       {"eslint", "prettier", "stylelint", "tslint", "firewall", "iptables", "ufw"},
	"rules":      {"eslint", "prettier", "stylelint", "tslint", "firewall", "iptables", "ufw"},
	"ルール":        {"eslint", "prettier", "stylelint", "tslint", "firewall", "iptables", "ufw"},
	"compact":    {"css", "json.stringify"},
	"compaction": {"leveldb", "rocksdb", "cassandra"},
	"コンパクト":      {"css", "json.stringify"},
	"skill":      {"alexa"},
	"skills":     {"alexa"},
	"スキル":        {"alexa"},
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

// isASCIIString reports whether s contains only ASCII characters.
func isASCIIString(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// isWordBoundary reports whether byte b is a word boundary (not letter/digit).
func isWordBoundary(b byte) bool {
	return !((b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '_')
}

// containsWord checks if text contains word at a word boundary.
// For ASCII keywords only — prevents "hook" matching "hooking" or "webhook".
func containsWord(text, word string) bool {
	wlen := len(word)
	for i := 0; ; {
		pos := strings.Index(text[i:], word)
		if pos < 0 {
			return false
		}
		pos += i
		startOK := pos == 0 || isWordBoundary(text[pos-1])
		endOK := pos+wlen >= len(text) || isWordBoundary(text[pos+wlen])
		if startOK && endOK {
			return true
		}
		i = pos + 1
	}
}

// detectClaudeCodeKeywords returns Claude Code keywords found in the prompt.
// Uses word boundary matching for ASCII keywords, substring for CJK.
func detectClaudeCodeKeywords(prompt string) []string {
	lower := strings.ToLower(prompt)
	var found []string
	seen := make(map[string]bool)
	for _, kw := range claudeCodeKeywordsLower {
		if seen[kw] {
			continue
		}
		var matched bool
		if isASCIIString(kw) {
			matched = containsWord(lower, kw)
		} else {
			matched = strings.Contains(lower, kw)
		}
		if !matched {
			continue
		}
		// For ambiguous keywords (hook, plugin, rule, etc.), check if the prompt
		// mentions a specific framework that uses the same term. If so, skip.
		if frameworks, ok := ambiguousKeywords[kw]; ok {
			negated := false
			for _, fw := range frameworks {
				if strings.Contains(lower, fw) {
					negated = true
					break
				}
			}
			if negated {
				continue
			}
		}
		seen[kw] = true
		found = append(found, kw)
	}
	return found
}

// isClaudeCodeRelated reports whether the prompt mentions Claude Code features.
func isClaudeCodeRelated(prompt string) bool {
	return len(detectClaudeCodeKeywords(prompt)) > 0
}

// extractSearchKeywords extracts meaningful keywords from a prompt for FTS search.
// Uses kagome POS for Japanese, stop word filtering for English.
func extractSearchKeywords(prompt string, maxWords int) string {
	if hasCJK(prompt) {
		return extractSearchKeywordsCJK(prompt, maxWords)
	}
	return extractSearchKeywordsASCII(prompt, maxWords)
}

// extractSearchKeywordsCJK uses kagome POS to extract content words from CJK text.
func extractSearchKeywordsCJK(prompt string, maxWords int) string {
	tok := getKagome()
	if tok == nil {
		return ""
	}
	seg := tok.Tokenize(prompt)
	var keywords []string
	for _, t := range seg {
		if !isContentPOS(t) {
			continue
		}
		surface := strings.TrimSpace(t.Surface)
		if surface == "" || len([]rune(surface)) < 2 {
			continue
		}
		keywords = append(keywords, surface)
		if len(keywords) >= maxWords {
			break
		}
	}
	return strings.Join(keywords, " OR ")
}

// extractSearchKeywordsASCII extracts keywords from English text using stop word filtering.
func extractSearchKeywordsASCII(prompt string, maxWords int) string {
	var keywords []string
	for _, word := range strings.Fields(strings.ToLower(prompt)) {
		word = strings.Trim(word, ".,!?;:\"'`()[]{}/-")
		if len(word) < 3 || englishStopWords[word] {
			continue
		}
		keywords = append(keywords, word)
		if len(keywords) >= maxWords {
			break
		}
	}
	return strings.Join(keywords, " ")
}

// englishStopWords are common English words that add no search value.
var englishStopWords = map[string]bool{
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

// kagomeTokenizer is lazily initialized on first use.
var (
	kagomeOnce sync.Once
	kagomeTok  *tokenizer.Tokenizer
)

func getKagome() *tokenizer.Tokenizer {
	kagomeOnce.Do(func() {
		t, err := tokenizer.New(ipa.Dict(), tokenizer.OmitBosEos())
		if err != nil {
			debugf("kagome init failed: %v", err)
			return
		}
		kagomeTok = t
	})
	return kagomeTok
}

// hasCJK reports whether s contains any CJK characters.
func hasCJK(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) {
			return true
		}
	}
	return false
}

// tokenizePrompt splits a prompt into searchable tokens.
// Uses kagome (IPA dictionary) for Japanese text, simple word splitting for ASCII.
//
//	"hookの設定方法を教えて" → ["hook", "の", "設定", "方法", "を", "教え", "て"]
//	"how to configure hooks" → ["how", "to", "configure", "hooks"]
func tokenizePrompt(s string) []string {
	if !hasCJK(s) {
		return tokenizeASCII(s)
	}
	tok := getKagome()
	if tok == nil {
		return tokenizeASCII(s)
	}
	seg := tok.Tokenize(s)
	tokens := make([]string, 0, len(seg))
	for _, t := range seg {
		surface := strings.TrimSpace(t.Surface)
		if surface == "" {
			continue
		}
		// Skip pure punctuation/symbols.
		hasLetterOrDigit := false
		for _, r := range surface {
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				hasLetterOrDigit = true
				break
			}
		}
		if !hasLetterOrDigit {
			continue
		}
		tokens = append(tokens, surface)
	}
	return tokens
}

// tokenizeASCII splits ASCII text on non-letter/digit boundaries.
func tokenizeASCII(s string) []string {
	var tokens []string
	var buf strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			buf.WriteRune(r)
		} else if buf.Len() > 0 {
			tokens = append(tokens, buf.String())
			buf.Reset()
		}
	}
	if buf.Len() > 0 {
		tokens = append(tokens, buf.String())
	}
	return tokens
}

// isContentPOS reports whether a kagome token is a content word (noun, verb, adjective).
// Filters out particles (助詞), auxiliaries (助動詞), symbols (記号), and fillers.
func isContentPOS(t tokenizer.Token) bool {
	pos := t.POS()
	if len(pos) == 0 {
		return false
	}
	switch pos[0] {
	case "名詞": // noun
		// Filter pronouns and non-independent nouns
		if len(pos) > 1 && (pos[1] == "代名詞" || pos[1] == "非自立") {
			return false
		}
		return true
	case "動詞": // verb
		// Only independent verbs, not auxiliaries like する/いる
		if len(pos) > 1 && pos[1] == "非自立" {
			return false
		}
		return true
	case "形容詞": // i-adjective
		return true
	case "副詞": // adverb — sometimes useful
		return true
	default:
		// 助詞, 助動詞, 記号, 接続詞, フィラー, 連体詞 → skip
		return false
	}
}

// isMeaningfulToken reports whether a token string is worth scoring.
// For CJK: filters single-character particles and common auxiliaries.
// For ASCII: requires 3+ characters.
func isMeaningfulToken(w string) bool {
	runeLen := len([]rune(w))
	isCJK := len(w) > runeLen // multi-byte = CJK
	if isCJK {
		if runeLen <= 1 {
			return false // single CJK char (particles)
		}
		// Filter common Japanese auxiliaries/copulas
		switch w {
		case "する", "いる", "ある", "なる", "できる",
			"です", "ます", "ない", "たい", "れる", "られる",
			"ください", "ている", "ておく", "てある":
			return false
		}
		return true
	}
	// ASCII: 3+ chars
	return runeLen >= 3
}

// contentTokensForScoring extracts meaningful content tokens from a prompt
// for relevance scoring. Uses kagome POS for CJK, stop word filtering for ASCII.
// Returns both surface forms and base forms (for cross-lingual matching).
// stemEnglish applies Snowball stemming to an English word.
// Returns the stem, or the original word if stemming fails.
func stemEnglish(word string) string {
	stemmed, err := snowball.Stem(word, "english", true)
	if err != nil || stemmed == "" {
		return word
	}
	return stemmed
}

func contentTokensForScoring(prompt string) []string {
	if !hasCJK(prompt) {
		// ASCII path: use tokenizeASCII + isMeaningfulToken + stemming
		tokens := tokenizeASCII(strings.ToLower(prompt))
		seen := make(map[string]bool)
		var result []string
		for _, w := range tokens {
			if !isMeaningfulToken(w) || englishStopWords[w] {
				continue
			}
			if !seen[w] {
				seen[w] = true
				result = append(result, w)
			}
			// Add stem for broader matching ("configuring" → "configur" matches "configuration")
			stemmed := stemEnglish(w)
			if stemmed != w && !seen[stemmed] {
				seen[stemmed] = true
				result = append(result, stemmed)
			}
		}
		return result
	}
	tok := getKagome()
	if tok == nil {
		tokens := tokenizeASCII(strings.ToLower(prompt))
		var result []string
		for _, w := range tokens {
			if isMeaningfulToken(w) {
				result = append(result, w)
			}
		}
		return result
	}
	seg := tok.Tokenize(prompt)
	seen := make(map[string]bool)
	var result []string
	for _, t := range seg {
		if !isContentPOS(t) {
			continue
		}
		surface := strings.ToLower(strings.TrimSpace(t.Surface))
		if surface == "" || len([]rune(surface)) < 2 {
			continue
		}
		if !seen[surface] {
			seen[surface] = true
			result = append(result, surface)
		}
		// Add base form if different (helps matching: 教え → 教える)
		if base, ok := t.BaseForm(); ok {
			baseLower := strings.ToLower(base)
			if baseLower != surface && baseLower != "*" && !seen[baseLower] {
				seen[baseLower] = true
				result = append(result, baseLower)
			}
		}
		// For ASCII tokens within CJK text, also add English stem
		if len(surface) == len([]rune(surface)) && len(surface) >= 3 {
			stemmed := stemEnglish(surface)
			if stemmed != surface && !seen[stemmed] {
				seen[stemmed] = true
				result = append(result, stemmed)
			}
		}
	}
	return result
}

// significantWords extracts significant words from text for duplicate detection.
// Uses tokenizePrompt for proper Japanese word segmentation, then filters
// by isMeaningfulToken to keep only content words.
func significantWords(text string) []string {
	tokens := tokenizePrompt(text)
	var result []string
	for _, w := range tokens {
		w = strings.Trim(w, ".,!?;:\"'`()[]{}/-")
		if isMeaningfulToken(w) {
			result = append(result, w)
		}
	}
	return result
}

// scoreRelevance computes a relevance score (0.0-1.0) for injecting a document.
//
// Two-signal design:
//   - Primary signal: matched Claude Code keywords in doc path/content (high weight)
//   - Secondary signal: prompt content token coverage in doc (bonus)
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
		if en, ok := katakanaToEnglish[kw]; ok {
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
	keywordScore := float64(kwPathHits)*0.40/float64(nkw) + float64(kwContentHits)*0.20/float64(nkw)

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
		coverageScore = float64(contentHits) / float64(len(meaningful)) * 0.30
	}
	earlyBonus := float64(earlyHits) * 0.05

	return min(keywordScore+coverageScore+earlyBonus, 1.0)
}

// handleUserPromptSubmit emits config reminders and proactively injects
// relevant knowledge from the FTS index based on the user's prompt.
//
// Precision design (v3):
// 1. Detect Claude Code keywords with word boundary + framework negation (Gate 1)
// 2. Search FTS using ONLY matched keywords — no synonym expansion (Gate 2)
// 3. Score with kagome tokenizer + keyword-aware relevance, threshold 0.40 (Gate 3)
// 4. Inject 1 result by default; 2 only if top score >= 0.65
func handleUserPromptSubmit(ev *hookEvent) {
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
		if en, ok := katakanaToEnglish[kw]; ok {
			ftsTerms = append(ftsTerms, en)
		} else {
			ftsTerms = append(ftsTerms, kw)
		}
	}
	ftsQuery := strings.Join(ftsTerms, " OR ")
	allDocs, _ := st.SearchDocsFTS(ftsQuery, "", 8)

	// Supplemental: also search with prompt keywords (no expansion) for coverage.
	keywords := extractSearchKeywords(prompt, 6)
	if keywords != "" {
		docs, _ := st.SearchDocsFTS(keywords, "", 3)
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
		if s >= 0.40 {
			candidates = append(candidates, scored{doc, s})
		}
	}
	if len(candidates) == 0 {
		debugf("UserPromptSubmit: no relevant matches (all below 0.40 threshold)")
		return
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].score > candidates[j].score
	})

	// Confidence-based injection: 1 result by default, 2 if top score is high.
	maxResults := 1
	if len(candidates) > 1 && candidates[0].score >= 0.65 {
		maxResults = 2
	}
	if len(candidates) > maxResults {
		candidates = candidates[:maxResults]
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
	emitAdditionalContext("UserPromptSubmit", buf.String())
	debugf("UserPromptSubmit: injected %d knowledge snippets (top score: %.2f, keywords: %v)", len(candidates), candidates[0].score, matched)
}
