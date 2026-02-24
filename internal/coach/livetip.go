package coach

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/parser"
)

// GenerateFeedback calls claude -p with recent activity to get feedback.
func GenerateFeedback(ctx context.Context, events []parser.SessionEvent, stats analyzer.Stats, lang locale.Lang, prevFeedbacks []analyzer.Feedback) (analyzer.Feedback, error) {
	if _, err := exec.LookPath("claude"); err != nil {
		return analyzer.Feedback{}, fmt.Errorf("claude CLI not found: %w", err)
	}

	summary := buildSummary(events, stats, prevFeedbacks)

	prompt := buildFeedbackPrompt(summary, lang)

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "claude", "-p", prompt)
	out, err := cmd.Output()
	if err != nil {
		return analyzer.Feedback{}, err
	}

	return parseFeedbackOutput(string(out)), nil
}

func buildFeedbackPrompt(summary string, lang locale.Lang) string {
	if lang.Code == "ja" {
		return fmt.Sprintf(`あなたはClaude Codeのベストプラクティス専門コーチです。
以下はユーザーのリアルタイムセッション状況です。

%s

以下のフォーマットで正確に4行出力してください:

SITUATION: (ユーザーが今やろうとしていること。イベント列から推定)
OBSERVATION: (セッションから気づいた事実・パターン)
SUGGESTION: (具体的で実行可能なアクション提案)
LEVEL: info|insight|warning|action

## 重要ルール
- 提案はユーザーが実行できるアクションに限定。Claude Code の内部動作への言及は禁止。
- 「あなた（ユーザー）がこうすべき」の形式で書く。
- SITUATIONはイベント列からユーザーの意図を推定して記述する。
- OBSERVATIONは統計や行動パターンから気づいた具体的な事実を書く。
- SUGGESTIONは今すぐ実行できる具体的アクション1つ。
- LEVELは info(一般), insight(非自明な発見), warning(潜在的問題), action(即時対応推奨) から選択。
- ラベル(SITUATION:/OBSERVATION:/SUGGESTION:/LEVEL:)は必ず英語のまま出力。内容は日本語で書く。

## 評価基準（Claude Code公式ベストプラクティス）
- CLAUDE.mdの活用: プロジェクトルールやビルドコマンドが定義されているか
- .claude/の設定: settings.json、カスタムスキル(.claude/skills/)、カスタムエージェント(.claude/agents/)の活用
- ツール選択: Bash grep/cat/find/sedではなく専用ツール(Grep/Read/Glob/Edit)を使用しているか
- Plan Mode: 複雑なタスクでEnterPlanModeを使用しているか
- サブエージェント: 並列探索にTask toolを活用しているか
- セッション管理: 長いセッションで/compactを使っているか
- プロンプト品質: 具体的なファイルパスや要件を含んでいるか

SITUATION:、OBSERVATION:、SUGGESTION:、LEVEL:の4行のみ出力。他のテキストは不要。`, summary)
	}

	return fmt.Sprintf(`You are a coach specializing in Claude Code official best practices.
Below is the user's real-time session status.

%s

Output exactly 4 lines in this format:

SITUATION: (What the user is currently trying to do — infer from the event stream)
OBSERVATION: (A concrete fact or pattern you noticed from the session)
SUGGESTION: (One specific, actionable improvement the user can make right now)
LEVEL: info|insight|warning|action

## CRITICAL RULES
- Suggestions MUST be actions the USER can take. NEVER reference Claude Code's internal behavior.
- Write as "You should..." (addressing the user), NOT "Claude should..." or "The AI could...".
- SITUATION: infer what the user is trying to accomplish from the event stream.
- OBSERVATION: state a concrete fact from statistics or behavior patterns.
- SUGGESTION: one specific action the user can take RIGHT NOW.
- LEVEL: info (general), insight (non-obvious finding), warning (potential issue), action (immediate action needed).
- Labels (SITUATION:/OBSERVATION:/SUGGESTION:/LEVEL:) must be in ASCII English.

## Evaluation criteria (Claude Code official best practices)
- CLAUDE.md usage: Are project rules and build commands defined in CLAUDE.md?
- .claude/ configuration: Are settings.json, custom skills (.claude/skills/), custom agents (.claude/agents/) being utilized?
- Tool selection: Using dedicated tools (Grep/Read/Glob/Edit) instead of Bash grep/cat/find/sed?
- Plan Mode: Using EnterPlanMode for complex tasks?
- Sub-agents: Using Task tool for parallel exploration/research?
- Session management: Using /compact for long sessions? Splitting tasks appropriately?
- Prompt quality: Including specific file paths and requirements in instructions?

Output ONLY the SITUATION:, OBSERVATION:, SUGGESTION:, and LEVEL: lines. No other text.`, summary)
}

func buildSummary(events []parser.SessionEvent, stats analyzer.Stats, prevFeedbacks []analyzer.Feedback) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Turns: %d, Tools: %d (%.1f/turn), Elapsed: %dmin\n",
		stats.TurnCount, stats.ToolUseCount, stats.ToolsPerTurn(), int(stats.Elapsed().Minutes())))
	if stats.LongestPause > 0 {
		sb.WriteString(fmt.Sprintf("Longest pause: %dmin\n", int(stats.LongestPause.Minutes())))
	}

	if len(stats.TopTools(5)) > 0 {
		var parts []string
		for _, t := range stats.TopTools(5) {
			parts = append(parts, fmt.Sprintf("%s:%d", t.Name, t.Count))
		}
		sb.WriteString("Top tools: " + strings.Join(parts, ", ") + "\n")
	}

	// Check for CLAUDE.md / .claude/ usage signals
	claudeMDUsed := false
	skillsUsed := false
	planModeUsed := false
	subagentUsed := false
	for _, ev := range events {
		if ev.Type == parser.EventToolUse {
			switch ev.ToolName {
			case "Read":
				if strings.Contains(ev.ToolInput, "CLAUDE.md") {
					claudeMDUsed = true
				}
				if strings.Contains(ev.ToolInput, ".claude/") {
					skillsUsed = true
				}
			case "Skill":
				skillsUsed = true
			case "EnterPlanMode":
				planModeUsed = true
			case "Task":
				subagentUsed = true
			}
		}
	}
	sb.WriteString(fmt.Sprintf("CLAUDE.md referenced: %v\n", claudeMDUsed))
	sb.WriteString(fmt.Sprintf(".claude/ skills/agents used: %v\n", skillsUsed))
	sb.WriteString(fmt.Sprintf("Plan Mode used: %v\n", planModeUsed))
	sb.WriteString(fmt.Sprintf("Subagent (Task) used: %v\n", subagentUsed))

	// Previous feedback (avoid repetition)
	if len(prevFeedbacks) > 0 {
		sb.WriteString("\nPrevious feedback (DO NOT repeat):\n")
		for _, fb := range prevFeedbacks {
			sb.WriteString(fmt.Sprintf("- %s | %s\n", fb.Observation, fb.Suggestion))
		}
	}

	// Last 20 events, compact
	start := 0
	if len(events) > 20 {
		start = len(events) - 20
	}
	sb.WriteString("\nRecent events:\n")
	for _, ev := range events[start:] {
		switch ev.Type {
		case parser.EventUserMessage:
			sb.WriteString("U: " + parser.Truncate(ev.UserText, 80) + "\n")
		case parser.EventToolUse:
			sb.WriteString("T: " + ev.ToolName + "(" + parser.Truncate(ev.ToolInput, 50) + ")\n")
		case parser.EventAssistantText:
			sb.WriteString("A: " + parser.Truncate(ev.AssistantText, 60) + "\n")
		}
	}
	return sb.String()
}

func parseFeedbackOutput(raw string) analyzer.Feedback {
	var fb analyzer.Feedback
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if after, ok := strings.CutPrefix(line, "SITUATION:"); ok {
			fb.Situation = strings.TrimSpace(after)
		} else if after, ok := strings.CutPrefix(line, "OBSERVATION:"); ok {
			fb.Observation = strings.TrimSpace(after)
		} else if after, ok := strings.CutPrefix(line, "SUGGESTION:"); ok {
			fb.Suggestion = strings.TrimSpace(after)
		} else if after, ok := strings.CutPrefix(line, "LEVEL:"); ok {
			fb.Level = analyzer.ParseLevel(after)
		}
	}
	if fb.Situation == "" {
		fb.Situation = "Analyzing session..."
	}
	if fb.Observation == "" {
		fb.Observation = "Gathering session data"
	}
	if fb.Suggestion == "" {
		fb.Suggestion = "Include specific file paths in your instructions for better accuracy"
	}
	return fb
}
