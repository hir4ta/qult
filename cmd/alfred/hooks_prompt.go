package main

import (
	"context"
	"strings"

	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// openStore is the function used to obtain a store connection.
// Overridable in tests.
var openStore = func() (*store.Store, error) {
	return store.OpenDefaultCached()
}

// ---------------------------------------------------------------------------
// UserPromptSubmit: semantic search + remember intent
// ---------------------------------------------------------------------------

// handleUserPromptSubmit performs semantic knowledge injection, detects
// "remember this" intent, and suggests relevant alfred skills.
//
// When VOYAGE_API_KEY is set: semantic search (embed + vector similarity)
// When unavailable: only remember hints and skill nudges are emitted.
func handleUserPromptSubmit(ctx context.Context, ev *hookEvent) {
	prompt := strings.TrimSpace(ev.Prompt)
	if len([]rune(prompt)) < 10 {
		return
	}

	// Detect "remember this" intent.
	rememberHint := ""
	if detectRememberIntent(prompt) {
		rememberHint = "User wants to save information. Use the ledger tool with action=save to persist this as permanent memory. " +
			"Parameters: content (what to save), label (short description), project (optional context)."
	}

	// Detect workflow intent and build skill nudge.
	skillNudge := ""
	intents := classifyIntent(prompt)
	if len(intents) > 0 {
		hasActiveSpec := hasActiveSpecTask(ev.ProjectPath)
		skillNudge = buildSkillNudge(intents, hasActiveSpec)
	}

	// Combine all hints (rememberHint + skillNudge) for injection.
	combinedHint := combineHints(rememberHint, skillNudge)

	// Semantic search for memories.
	if handleSemanticSearch(ctx, ev, prompt, combinedHint) {
		return
	}

	// Voyage unavailable — emit non-search hints only.
	if combinedHint != "" {
		emitAdditionalContext("UserPromptSubmit", combinedHint)
	}
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

// ---------------------------------------------------------------------------
// Skill nudge: intent detection + routing
// ---------------------------------------------------------------------------

// intentRule maps a workflow intent to its trigger keywords (JP+EN).
// Keywords are phrase-level to minimize false positives.
type intentRule struct {
	intent   string
	keywords []string
}

// intentRules defines the intent detection keywords.
// Order matters: save-knowledge is checked first so it can suppress research.
var intentRules = []intentRule{
	{"save-knowledge", []string{
		"調査結果", "比較結果", "分析結果", "知見を", "学んだ",
		"findings", "insights", "lessons learned", "what we learned",
	}},
	{"research", []string{
		"調査して", "調べて", "コードを読んで", "把握して", "理解して",
		"investigate", "explore the code", "research", "understand the code", "reverse engineer",
	}},
	{"plan", []string{
		"設計して", "仕様を", "計画して", "プランを",
		"design this", "write a spec", "plan this", "architect",
	}},
	{"implement", []string{
		"実装して", "実装を", "コーディングして", "開発して",
		"implement", "develop this", "code this",
	}},
	{"bugfix", []string{
		"バグを", "バグ修正", "直して", "修正して", "デバッグ",
		"fix this bug", "debug this", "fix the bug", "broken",
	}},
	{"review", []string{
		"レビューして", "コードレビュー", "品質チェック",
		"review this", "review the code", "code review", "audit this",
	}},
	{"tdd", []string{
		"テスト駆動", "テストファースト", "tdd",
		"test first", "test driven", "red green refactor",
	}},
}

// classifyIntent detects workflow intents from the prompt using keyword matching.
// Returns matched intent names. When save-knowledge is detected, research is suppressed
// to avoid conflicting suggestions.
func classifyIntent(prompt string) []string {
	lower := strings.ToLower(prompt)
	var intents []string
	seen := map[string]bool{}

	for _, rule := range intentRules {
		if seen[rule.intent] {
			continue
		}
		for _, kw := range rule.keywords {
			if strings.Contains(lower, kw) {
				intents = append(intents, rule.intent)
				seen[rule.intent] = true
				break
			}
		}
	}

	// Suppress research when save-knowledge is detected (the user has results, not seeking them).
	if seen["save-knowledge"] && seen["research"] {
		filtered := intents[:0]
		for _, i := range intents {
			if i != "research" {
				filtered = append(filtered, i)
			}
		}
		intents = filtered
	}

	return intents
}

// skillRoute maps an intent to a skill suggestion.
type skillRoute struct {
	intent      string
	skill       string
	description string
	suppressIf  string // "active_spec" → suppress when a spec is active
}

// skillRoutes defines intent-to-skill mappings.
var skillRoutes = []skillRoute{
	{"research", "/alfred:survey", "既存コードからspec逆生成", ""},
	{"plan", "/alfred:brief", "仕様作成 + 並列レビュー", "active_spec"},
	{"implement", "/alfred:attend", "spec→承認→実装→レビュー→コミット自律実行", "active_spec"},
	{"bugfix", "/alfred:mend", "再現→分析→修正→検証の自律バグ修正", ""},
	{"review", "/alfred:inspect", "6プロファイル品質レビュー", ""},
	{"tdd", "/alfred:tdd", "テスト駆動開発 — red/green/refactor自律サイクル", ""},
	{"save-knowledge", "ledger action=save", "知見を永続記憶に保存", ""},
}

// buildSkillNudge generates suggestion text from detected intents.
// Suppresses plan/implement suggestions when a spec is already active.
func buildSkillNudge(intents []string, hasActiveSpec bool) string {
	if len(intents) == 0 {
		return ""
	}

	intentSet := map[string]bool{}
	for _, i := range intents {
		intentSet[i] = true
	}

	var lines []string
	for _, route := range skillRoutes {
		if !intentSet[route.intent] {
			continue
		}
		if route.suppressIf == "active_spec" && hasActiveSpec {
			continue
		}
		lines = append(lines, "Skill suggestion: "+route.skill+" — "+route.description)
	}

	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n")
}

// hasActiveSpecTask checks if there is an active spec task in the project.
func hasActiveSpecTask(projectPath string) bool {
	if projectPath == "" {
		return false
	}
	_, err := spec.ReadActive(projectPath)
	return err == nil
}

// combineHints joins non-empty hint strings with double newline.
func combineHints(hints ...string) string {
	var parts []string
	for _, h := range hints {
		if h != "" {
			parts = append(parts, h)
		}
	}
	return strings.Join(parts, "\n\n")
}
