package main

import (
	"encoding/json"
	"sort"
	"strings"
)

// ---------------------------------------------------------------------------
// Decision extraction from transcript
// ---------------------------------------------------------------------------

// Decision confidence scoring constants.
// Both values are 0.4: a sentence with ONLY a decision keyword (no rationale,
// no alternative comparison, no architecture terms) is at the exact threshold.
// Any positive signal (rationale +0.25, alternative +0.3, arch term +0.15) pushes it above;
// any negative signal (backtick -0.15, hedge -0.1) drops it below. This design ensures
// only decisions with supporting evidence survive.
const (
	// decisionBaseScore is the starting confidence for having a decision keyword.
	decisionBaseScore = 0.4
	// decisionMinConfidence is the minimum score to keep a decision.
	decisionMinConfidence = 0.4
)

// trivialVerbs are verbs that follow decision keywords but indicate
// routine actions rather than real design decisions.
var trivialVerbs = []string{
	// English
	"read ", "check ", "look ", "run ", "open ", "try ", "start ",
	"continue ", "proceed ", "skip ", "move ", "fix ", "update ",
	"install ", "build ", "test ", "debug ", "print ", "log ",
	"add ", "remove ", "delete ", "rename ", "import ", "copy ",
	"format ", "lint ", "commit ", "push ", "pull ", "merge ",
	"revert ", "rebase ",
	// Japanese (読む, 確認する, 見る, 実行する, etc.)
	"読む", "確認する", "確認し", "見る", "見て", "実行する", "実行し",
	"開く", "試す", "試し", "始める", "続ける", "進める",
	"飛ばす", "スキップする", "直す", "修正する", "修正し",
	"更新する", "更新し", "追加する", "追加し", "削除する", "削除し",
	"テストする", "テストし", "ビルドする", "ビルドし",
	"インストールする", "インストールし", "コミットする", "コミットし",
	"プッシュする", "プッシュし",
}

// rationaleMarkers indicate the sentence contains a reason/justification,
// which strongly suggests a real design decision.
var rationaleMarkers = []string{
	// English
	"because ", "since ", "due to ", "given that ", "in order to ",
	"so that ", "for better ", "to ensure ", "to avoid ", "to reduce ",
	"to improve ", "to support ", "for the sake of ",
	// Japanese (〜ため, 〜ので, 〜から, 理由は, etc.)
	"ため", "ので", "だから", "から、", "なぜなら",
	"理由は", "理由として", "目的で", "観点から",
	"を避ける", "を防ぐ", "を確保する", "を担保する",
	"の方が", "を改善する", "を向上させる",
	"によって", "に基づいて", "を考慮して", "を踏まえて",
}

// alternativeMarkers indicate the sentence compares options,
// which is a strong signal for a design decision.
var alternativeMarkers = []string{
	// English
	" over ", " instead of ", " rather than ", " vs ", " versus ",
	" compared to ", " as opposed to ",
	// Japanese (〜より, 〜ではなく, 〜の代わりに, etc.)
	"よりも", "ではなく", "じゃなく", "の代わりに", "のかわりに",
	"を選択", "を採用", "を選んだ", "にした",
	"と比較して", "と比較する", "と比べて", "と比べる",
	"に対して", "とは異なり", "一方で",
	"も検討し", "案もあり", "代替案", "候補として",
}

// architectureTerms boost confidence when the sentence mentions design concepts.
var architectureTerms = []string{
	// English
	"architecture", "pattern", "approach", "strategy", "trade-off",
	"tradeoff", "schema", "interface", "protocol", "abstraction",
	"design", "api ", "migration", "infrastructure",
	// Japanese
	"アーキテクチャ", "パターン", "アプローチ", "戦略", "トレードオフ",
	"スキーマ", "インターフェース", "インタフェース", "プロトコル", "抽象化",
	"設計", "構成", "構造", "方式", "方針", "移行", "基盤",
	"コンポーネント", "モジュール", "依存関係", "疎結合", "責務",
	"レイヤー", "データフロー", "ワークフロー", "ライフサイクル",
}

// confidenceSignal groups related markers with their scoring weight.
type confidenceSignal struct {
	markers []string
	weight  float64
}

// decisionSignals defines all confidence scoring signals in one place.
// Positive weights boost confidence; negative weights penalize.
var decisionSignals = []confidenceSignal{
	{markers: rationaleMarkers, weight: +0.25},
	{markers: alternativeMarkers, weight: +0.30},
	{markers: architectureTerms, weight: +0.15},
	{markers: []string{
		"just ", "simply ", "quickly ",
		"とりあえず", "一旦", "ちょっと", "簡単に",
	}, weight: -0.10},
}

// scoreDecisionConfidence returns a confidence score (0.0-1.0) for whether
// a sentence represents a real design decision vs an implementation action.
func scoreDecisionConfidence(sentence string) float64 {
	lower := strings.ToLower(sentence)
	score := decisionBaseScore // base score for having a decision keyword

	for _, sig := range decisionSignals {
		for _, marker := range sig.markers {
			if strings.Contains(lower, marker) {
				score += sig.weight
				break
			}
		}
	}

	// Code artifact penalties (regex-like, not marker-based).
	if strings.Contains(sentence, "`") {
		score -= 0.15
	}
	if strings.Contains(sentence, "/") && strings.Contains(sentence, ".") {
		score -= 0.1
	}

	return min(max(score, 0), 1.0)
}

// isTrivialDecision returns true if the sentence describes a routine action
// rather than a meaningful design/architecture decision.
func isTrivialDecision(sentence string) bool {
	lower := strings.ToLower(sentence)
	for _, v := range trivialVerbs {
		// Check if a trivial verb follows a decision keyword.
		for _, kw := range []string{
			"decided to ", "chose to ", "going to ",
			"ことにした", "にした",
		} {
			if strings.Contains(lower, kw+v) {
				return true
			}
		}
	}
	// Too short to be a real decision (rune-based for CJK).
	if len([]rune(sentence)) < 20 {
		return true
	}
	return false
}

// checkTranscriptFormat samples up to 20 JSON lines and returns true if the
// transcript appears parseable (at least 70% of sampled lines parse as valid
// transcript entries with expected fields).
// Returns true if no lines were sampled (empty transcript is acceptable).
func checkTranscriptFormat(lines []string) bool {
	parsedCount, structuralCount, totalCount := 0, 0, 0
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || line[0] != '{' {
			continue
		}
		totalCount++
		if totalCount > 20 {
			break
		}
		var probe map[string]any
		if json.Unmarshal([]byte(line), &probe) == nil {
			parsedCount++
			// Structural validation: check for known transcript fields.
			if hasTranscriptFields(probe) {
				structuralCount++
			}
		}
	}
	if totalCount == 0 {
		return true
	}
	// Require 70% parse success AND at least 50% structural validity.
	return parsedCount*10 >= totalCount*7 && structuralCount*2 >= parsedCount
}

// hasTranscriptFields checks if a parsed JSON object contains expected
// transcript entry fields (type, role, or message with a role).
func hasTranscriptFields(m map[string]any) bool {
	knownTypes := map[string]bool{
		"human": true, "assistant": true, "tool_use": true, "tool_result": true,
		"tool_error": true, "error": true, "system": true,
	}
	if t, ok := m["type"].(string); ok && knownTypes[t] {
		return true
	}
	if r, ok := m["role"].(string); ok && (r == "user" || r == "assistant" || r == "system") {
		return true
	}
	if msg, ok := m["message"].(map[string]any); ok {
		if r, ok := msg["role"].(string); ok && (r == "user" || r == "assistant") {
			return true
		}
	}
	return false
}

// extractDecisionsFromTranscript scans the transcript for meaningful design decisions
// from the assistant. Uses keyword matching + structured pattern detection + trivial filtering.
func extractDecisionsFromTranscript(transcriptPath string) []string {
	// Read last 64KB of transcript — enough for ~50-100 conversation turns.
	// Larger values increase memory/CPU without meaningfully improving recall.
	data, err := readFileTail(transcriptPath, 64*1024)
	if err != nil {
		return nil
	}

	// Keyword patterns that indicate design decisions (not routine actions).
	decisionKeywords := []string{
		// English
		"decided to ", "chose ", "going with ", "selected ",
		"decision: ", "we'll use ", "opting for ",
		"settled on ", "choosing ", "picked ",
		// Japanese (決めた, 選んだ, 採用した, 方針として, etc.)
		// Stems cover conjugation variants via substring matching:
		//   "に決め" → に決めた / に決めました / に決めます
		"にした", "に決め", "に決定し", "を決め", "を決定し",
		"を選んだ", "を選択し", "を選び",
		"を採用し", "を採用する",
		"にしました", "にします",
		"方針として", "方針で", "結論として",
		"判断し", "で行き", "で行こう", "で進め",
		"ことにし", "を導入し", "で実装",
		// AI assistant typical expressions
		"が最適", "が適切", "をお勧め", "を推奨",
	}

	// Structured patterns from spec format or explicit decision markers.
	structuredPrefixes := []string{
		"**chosen:**", "**decision:**", "**selected:**",
		"- chosen: ", "- decision: ", "- selected: ",
		// Japanese structured markers (half-width and full-width colons)
		"**採用:**", "**決定:**", "**選択:**", "**結論:**", "**方針:**", "**判断:**",
		"**採用：**", "**決定：**", "**選択：**", "**結論：**", "**方針：**", "**判断：**",
		"- 採用: ", "- 決定: ", "- 選択: ", "- 結論: ", "- 方針: ", "- 判断: ",
		"- 採用： ", "- 決定： ", "- 選択： ", "- 結論： ", "- 方針： ", "- 判断： ",
	}

	// Transcript format guard.
	allLines := strings.Split(string(data), "\n")
	if !checkTranscriptFormat(allLines) {
		debugf("extractDecisions: transcript format guard triggered")
		return nil
	}

	type scoredDecision struct {
		text       string
		confidence float64
	}
	var decisions []scoredDecision
	for _, line := range allLines {
		line = strings.TrimSpace(line)
		if line == "" || line[0] != '{' {
			continue
		}
		var entry transcriptEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}

		role := entry.Role
		if role == "" {
			role = entry.Message.Role
		}
		if role != "assistant" && entry.Type != "assistant" {
			continue
		}

		text := extractTextContent(entry)
		if text == "" {
			continue
		}
		textLower := strings.ToLower(text)

		// Strategy 1: Structured patterns (high confidence = 0.9).
		for _, prefix := range structuredPrefixes {
			idx := strings.Index(textLower, prefix)
			if idx < 0 {
				continue
			}
			rest := strings.TrimSpace(text[idx+len(prefix):])
			end := strings.IndexAny(rest, "\n")
			if end < 0 {
				end = min(len(rest), 200)
			}
			value := strings.TrimSpace(rest[:end])
			if len(value) > 5 {
				decisions = append(decisions, scoredDecision{value, 0.9})
			}
			break
		}

		// Strategy 2: Keyword matching with confidence scoring.
		for _, kw := range decisionKeywords {
			idx := strings.Index(textLower, kw)
			if idx < 0 {
				continue
			}
			start := strings.LastIndexAny(text[:idx], ".!?\n") + 1
			end := strings.IndexAny(text[idx:], ".!?\n")
			if end < 0 {
				end = min(len(text)-idx, 200)
			}
			sentence := strings.TrimSpace(text[start : idx+end])
			if len(sentence) > 10 && len(sentence) < 300 && !isTrivialDecision(sentence) {
				conf := scoreDecisionConfidence(sentence)
				if conf >= decisionMinConfidence {
					decisions = append(decisions, scoredDecision{sentence, conf})
				}
			}
			break // one decision per entry
		}
	}

	// Deduplicate, keeping the highest confidence version.
	seen := make(map[string]int) // key -> index in unique
	var unique []scoredDecision
	for _, d := range decisions {
		key := strings.ToLower(d.text)
		if len(key) > 80 {
			key = key[:80]
		}
		if idx, ok := seen[key]; ok {
			if d.confidence > unique[idx].confidence {
				unique[idx] = d
			}
		} else {
			seen[key] = len(unique)
			unique = append(unique, d)
		}
	}

	// Sort by confidence descending, keep last 5.
	sort.Slice(unique, func(i, j int) bool {
		return unique[i].confidence > unique[j].confidence
	})
	if len(unique) > 5 {
		unique = unique[:5]
	}

	result := make([]string, len(unique))
	for i, d := range unique {
		result[i] = d.text
	}
	return result
}

// ---------------------------------------------------------------------------
// Transcript context extraction
// ---------------------------------------------------------------------------

// transcriptContext holds structured context extracted from a conversation transcript.
type transcriptContext struct {
	UserMessages       []string // last 5 user messages (200 chars each)
	AssistantActions   []string // last 5 assistant messages (300 chars each)
	ToolErrors         []string // last 3 tool errors
	LastUserDirective  string   // the very last user message (full, up to 500 chars)
	LastAssistantWork  string   // the very last assistant message (full, up to 500 chars)
	RunningAgents      []string // agents that were spawned but may not have completed
	RecentToolUses     []string // recent tool calls for context
}

// extractTranscriptContextRich reads the tail of a conversation transcript and
// extracts structured context: recent user messages, assistant summaries,
// tool errors, running agents, and recent tool uses.
func extractTranscriptContextRich(transcriptPath string) *transcriptContext {
	data, err := readFileTail(transcriptPath, 128*1024)
	if err != nil {
		debugf("PreCompact: read transcript error: %v", err)
		return nil
	}

	ctx := &transcriptContext{}
	lines := strings.Split(string(data), "\n")

	// Track agents: agent tool_use entries that may still be running.
	agentStarts := make(map[string]string) // tool_use_id -> description

	// Transcript format guard: if most lines fail to parse, the format
	// may have changed. Parse a sample first to detect this.
	if !checkTranscriptFormat(lines) {
		notifyUser("warning: transcript format may have changed")
		debugf("PreCompact: transcript format guard triggered")
		return nil
	}

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || line[0] != '{' {
			continue
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}

		// Build transcriptEntry from the already-parsed raw map to avoid double unmarshal.
		entry := entryFromRaw(raw)
		text := extractTextContent(entry)

		// Detect agent tool_use starts.
		extractAgentToolUses(raw, agentStarts)

		// Detect agent completions to remove from running set.
		extractAgentCompletions(raw, agentStarts)

		// Extract recent tool uses for context.
		if toolName := extractToolName(raw); toolName != "" {
			desc := truncateStr(toolName, 100)
			ctx.RecentToolUses = append(ctx.RecentToolUses, desc)
			if len(ctx.RecentToolUses) > 5 {
				ctx.RecentToolUses = ctx.RecentToolUses[len(ctx.RecentToolUses)-5:]
			}
		}

		if text == "" {
			continue
		}

		switch {
		case entry.Type == "human" || entry.Role == "user" ||
			(entry.Message.Role == "user"):
			ctx.UserMessages = append(ctx.UserMessages, truncateStr(text, 200))
			if len(ctx.UserMessages) > 5 {
				ctx.UserMessages = ctx.UserMessages[len(ctx.UserMessages)-5:]
			}
			ctx.LastUserDirective = truncateStrKeepNewlines(text, 500)

		case entry.Type == "assistant" || entry.Role == "assistant" ||
			(entry.Message.Role == "assistant"):
			ctx.AssistantActions = append(ctx.AssistantActions, truncateStr(text, 300))
			if len(ctx.AssistantActions) > 5 {
				ctx.AssistantActions = ctx.AssistantActions[len(ctx.AssistantActions)-5:]
			}
			ctx.LastAssistantWork = truncateStrKeepNewlines(text, 500)

		case entry.Type == "tool_error" || entry.Type == "error":
			ctx.ToolErrors = append(ctx.ToolErrors, truncateStr(text, 150))
			if len(ctx.ToolErrors) > 3 {
				ctx.ToolErrors = ctx.ToolErrors[len(ctx.ToolErrors)-3:]
			}
		}
	}

	// Remaining agent starts are likely still running.
	for _, desc := range agentStarts {
		ctx.RunningAgents = append(ctx.RunningAgents, desc)
	}

	return ctx
}

// extractAgentToolUses detects Agent tool_use entries from transcript raw JSON.
func extractAgentToolUses(raw map[string]any, agentStarts map[string]string) {
	// Look in message.content for tool_use blocks with name "Agent".
	content := getNestedContent(raw)
	blocks, ok := content.([]any)
	if !ok {
		return
	}
	for _, b := range blocks {
		block, ok := b.(map[string]any)
		if !ok {
			continue
		}
		if block["type"] != "tool_use" {
			continue
		}
		name, _ := block["name"].(string)
		if name != "Agent" && name != "agent" {
			continue
		}
		id, _ := block["id"].(string)
		if id == "" {
			continue
		}
		// Extract description from input.
		input, _ := block["input"].(map[string]any)
		desc, _ := input["description"].(string)
		prompt, _ := input["prompt"].(string)
		if desc == "" {
			desc = truncateStr(prompt, 80)
		}
		agentStarts[id] = desc
	}
}

// extractAgentCompletions detects tool_result entries that mark an agent as complete.
func extractAgentCompletions(raw map[string]any, agentStarts map[string]string) {
	// Tool results have tool_use_id field.
	content := getNestedContent(raw)
	blocks, ok := content.([]any)
	if !ok {
		return
	}
	for _, b := range blocks {
		block, ok := b.(map[string]any)
		if !ok {
			continue
		}
		if block["type"] != "tool_result" {
			continue
		}
		if id, ok := block["tool_use_id"].(string); ok {
			delete(agentStarts, id)
		}
	}
}

// extractToolName extracts the tool name from a tool_use transcript entry.
func extractToolName(raw map[string]any) string {
	content := getNestedContent(raw)
	blocks, ok := content.([]any)
	if !ok {
		return ""
	}
	for _, b := range blocks {
		block, ok := b.(map[string]any)
		if !ok {
			continue
		}
		if block["type"] == "tool_use" {
			if name, ok := block["name"].(string); ok {
				return name
			}
		}
	}
	return ""
}

// getNestedContent extracts the content field from either top-level or message.content.
func getNestedContent(raw map[string]any) any {
	if c, ok := raw["content"]; ok {
		return c
	}
	if msg, ok := raw["message"].(map[string]any); ok {
		return msg["content"]
	}
	return nil
}

// truncateStrKeepNewlines truncates to maxLen runes but preserves newlines
// (unlike truncateStr which flattens to single line).
func truncateStrKeepNewlines(s string, maxLen int) string {
	s = strings.TrimSpace(s)
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen]) + "..."
}

