package analyzer

import (
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/parser"
)

// Regex patterns for destructive command detection.
var (
	rmRFPattern         = regexp.MustCompile(`\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\b`)
	gitPushForcePattern = regexp.MustCompile(`\bgit\s+push\s+(-f\b|--force\b)`)
	gitResetHardPattern = regexp.MustCompile(`\bgit\s+reset\s+--hard\b`)
	gitCheckoutDot      = regexp.MustCompile(`\bgit\s+checkout\s+--\s*\.`)
	gitRestoreDot       = regexp.MustCompile(`\bgit\s+restore\s+\.`)
	gitCleanF           = regexp.MustCompile(`\bgit\s+clean\s+-f`)
	gitBranchD          = regexp.MustCompile(`\bgit\s+branch\s+-D\b`)
	chmod777            = regexp.MustCompile(`\bchmod\s+777\b`)
)

// Test command patterns for test-fail cycle detection.
var testCmdPattern = regexp.MustCompile(`\b(go\s+test|npm\s+test|npx\s+jest|pytest|jest|cargo\s+test|make\s+test)\b`)

// Apology keywords for apologize-retry detection.
var apologyKeywords = []string{
	"i apologize",
	"sorry about that",
	"let me fix",
	"my mistake",
	"i'm sorry",
	"my apologies",
	"申し訳",
	"すみません",
}

// Rate-limit keywords.
var rateLimitKeywords = []string{"rate limit", "overloaded", "429", "529"}

// MatchDestructiveCommand checks if a Bash command matches destructive patterns.
// Returns observation, suggestion, and whether a match was found.
func MatchDestructiveCommand(command string) (observation, suggestion string, matched bool) {
	switch {
	case rmRFPattern.MatchString(command):
		return "rm -rf command detected",
			"Verify the target path — use git checkout to restore if unintended",
			true
	case gitPushForcePattern.MatchString(command) && !strings.Contains(command, "--force-with-lease"):
		return "git push --force detected",
			"Remote changes will be overwritten — use --force-with-lease instead",
			true
	case gitResetHardPattern.MatchString(command):
		return "git reset --hard detected",
			"Uncommitted changes will be lost — use git stash or git reflog instead",
			true
	case gitCheckoutDot.MatchString(command):
		return "git checkout -- . will discard all working directory changes",
			"Use git stash to save changes before discarding",
			true
	case gitRestoreDot.MatchString(command):
		return "git restore . will discard all working directory changes",
			"Use git stash to save changes before discarding",
			true
	case gitCleanF.MatchString(command):
		return "git clean -f will remove untracked files permanently",
			"Use git clean -n to preview first",
			true
	case gitBranchD.MatchString(command):
		return "git branch -D will force-delete a branch",
			"Use git branch -d (lowercase) for safe deletion, or git reflog to recover",
			true
	case chmod777.MatchString(command):
		return "chmod 777 grants world-writable permissions",
			"Security risk — use minimal permissions (644 or 755)",
			true
	default:
		return "", "", false
	}
}

// detectRetryLoop scans last 10 events for 3+ consecutive identical tool calls.
func (d *Detector) detectRetryLoop() *Alert {
	recent := d.getRecentFingerprints(10)
	if len(recent) < 3 {
		return nil
	}

	consecutiveCount := 1
	for i := 1; i < len(recent); i++ {
		cur := recent[i-1]
		prev := recent[i]
		if cur.ToolName == "" || prev.ToolName == "" {
			break
		}
		if cur.ToolName == prev.ToolName && cur.InputHash == prev.InputHash {
			consecutiveCount++
		} else {
			break
		}
	}

	if consecutiveCount < 2 {
		return nil
	}

	toolName := recent[0].ToolName
	filePath := recent[0].FilePath
	short := shortPath(filePath)
	count := itoa(consecutiveCount)

	kind := KindAlert
	level := LevelWarning
	switch {
	case consecutiveCount >= 5:
		level = LevelAction
	case consecutiveCount >= 3:
		level = LevelWarning
	default: // 2 retries
		kind = KindProposal
		level = LevelInfo
	}

	var obs, suggestion string
	if d.isJa() {
		obs = toolName
		if filePath != "" {
			obs += " → " + short
		}
		obs += " を" + count + "回連続リトライ中"
		suggestion = d.retrySuggestionJa(toolName, kind, level)
	} else {
		obs = toolName
		if filePath != "" {
			obs += " → " + short
		}
		obs += " retried " + count + " times consecutively"
		suggestion = d.retrySuggestionEn(toolName, kind, level)
	}

	return &Alert{
		Pattern:     PatternRetryLoop,
		Kind:        kind,
		Level:       level,
		Situation:   "Consecutive identical tool calls detected",
		Observation: obs,
		Suggestion:  suggestion,
		EventCount:  consecutiveCount,
	}
}

// detectCompactAmnesia checks if files are being re-read after compact.
func (d *Detector) detectCompactAmnesia() *Alert {
	if !d.compaction.inPostCompact {
		return nil
	}
	if d.compaction.postCompactCount < 30 {
		return nil
	}
	if len(d.compaction.preCompactReads) == 0 {
		return nil
	}

	overlap := 0
	for f := range d.compaction.postCompactReads {
		if d.compaction.preCompactReads[f] {
			overlap++
		}
	}

	if len(d.compaction.postCompactReads) == 0 {
		return nil
	}

	ratio := float64(overlap) / float64(len(d.compaction.postCompactReads))
	if ratio <= 0.6 {
		return nil
	}

	d.compaction.inPostCompact = false // only alert once

	files := d.overlapFiles(3)
	fileList := strings.Join(files, ", ")
	n := itoa(overlap)

	var obs, suggestion string
	if d.isJa() {
		obs = "compact 後に "
		if len(files) > 0 {
			obs += fileList
			if overlap > len(files) {
				obs += " など"
			}
			obs += " " + n + "ファイルを再読込中"
		} else {
			obs += n + "ファイルを再読込中"
		}
		suggestion = "buddy_recall でキーワード検索すると compact 前の文脈を復元できます — 再読込より高速です"
	} else {
		obs = "Re-reading " + n + " files after compact"
		if len(files) > 0 {
			obs += " (" + fileList
			if overlap > len(files) {
				obs += " etc."
			}
			obs += ")"
		}
		suggestion = "Use buddy_recall to search for pre-compact context — faster than re-reading files"
	}

	return &Alert{
		Pattern:     PatternCompactAmnesia,
		Level:       LevelWarning,
		Situation:   "Files re-read after context compaction",
		Observation: obs,
		Suggestion:  suggestion,
		EventCount:  overlap,
	}
}

// detectExcessiveTools checks for too many tool calls without user input.
func (d *Detector) detectExcessiveTools() *Alert {
	if d.burst.toolCount < 25 {
		return nil
	}

	level := LevelWarning
	if d.burst.toolCount >= 40 {
		level = LevelAction
	}

	fileCount := len(d.burst.uniqueFiles)
	tc := itoa(d.burst.toolCount)
	fc := itoa(fileCount)

	var elapsed time.Duration
	if !d.burst.startTime.IsZero() && !d.burst.lastToolTime.IsZero() {
		elapsed = d.burst.lastToolTime.Sub(d.burst.startTime)
	}

	var obs, suggestion string
	if d.isJa() {
		obs = tc + "回のツール呼び出し（"
		if d.burst.hasWrite {
			obs += fc + "ファイル変更"
		} else {
			obs += fc + "ファイル読込、書込なし"
		}
		if elapsed >= time.Minute {
			obs += "、" + itoa(int(elapsed.Minutes())) + "分経過"
		}
		obs += "）"
		suggestion = d.excessiveToolsSuggestionJa(fileCount)
	} else {
		obs = tc + " tool calls ("
		if d.burst.hasWrite {
			obs += fc + " files modified"
		} else {
			obs += fc + " files read, no writes"
		}
		if elapsed >= time.Minute {
			obs += ", " + itoa(int(elapsed.Minutes())) + "m elapsed"
		}
		obs += ")"
		suggestion = d.excessiveToolsSuggestionEn(fileCount)
	}

	return &Alert{
		Pattern:     PatternExcessiveTools,
		Level:       level,
		Situation:   "Long burst of tool calls without user input",
		Observation: obs,
		Suggestion:  suggestion,
		EventCount:  d.burst.toolCount,
	}
}

// detectDestructiveCmd checks for dangerous shell commands.
func (d *Detector) detectDestructiveCmd(ev parser.SessionEvent) *Alert {
	if ev.Type != parser.EventToolUse || ev.ToolName != "Bash" {
		return nil
	}

	input := ev.ToolInput
	if input == "" {
		return nil
	}

	type cmdMsg struct{ obsJa, obsEn, suggJa, suggEn string }

	var m cmdMsg
	switch {
	case rmRFPattern.MatchString(input):
		m = cmdMsg{
			"rm -rf が実行されました",
			"rm -rf command executed",
			"削除対象のパスを確認してください — 誤って実行された場合 git checkout で復元できます",
			"Verify the target path — use git checkout to restore if unintended",
		}
	case gitPushForcePattern.MatchString(input) && !strings.Contains(input, "--force-with-lease"):
		m = cmdMsg{
			"git push --force が実行されました",
			"git push --force executed",
			"リモートの変更が上書きされます — --force-with-lease の方が安全です",
			"Remote changes will be overwritten — use --force-with-lease instead",
		}
	case gitResetHardPattern.MatchString(input):
		m = cmdMsg{
			"git reset --hard が実行されました",
			"git reset --hard executed",
			"コミットしていない変更は失われます — git reflog で直前の状態を確認できます",
			"Uncommitted changes are lost — use git reflog to find previous state",
		}
	case gitCheckoutDot.MatchString(input):
		m = cmdMsg{
			"作業ディレクトリの全変更が破棄されました",
			"All working directory changes discarded",
			"git stash で変更を一時保存してから操作する方が安全です",
			"Use git stash to save changes before discarding",
		}
	case gitRestoreDot.MatchString(input):
		m = cmdMsg{
			"作業ディレクトリの全変更が破棄されました",
			"All working directory changes discarded",
			"git stash で変更を一時保存してから操作する方が安全です",
			"Use git stash to save changes before discarding",
		}
	case gitCleanF.MatchString(input):
		m = cmdMsg{
			"git clean -f で未追跡ファイルが削除されました",
			"git clean -f removed untracked files",
			"削除されたファイルは復元できません — 事前に git clean -n で確認してください",
			"Removed files cannot be recovered — use git clean -n to preview first",
		}
	case gitBranchD.MatchString(input):
		m = cmdMsg{
			"git branch -D でブランチが強制削除されました",
			"git branch -D force-deleted a branch",
			"マージ前のブランチなら git reflog からコミットを復元できます",
			"If unmerged, use git reflog to recover the branch's commits",
		}
	case chmod777.MatchString(input):
		m = cmdMsg{
			"chmod 777 で全ユーザーに書込/実行権限が付与されました",
			"chmod 777 granted world-writable permissions",
			"セキュリティリスクがあります — 最小限の権限（644 or 755）を使ってください",
			"Security risk — use minimal permissions (644 or 755)",
		}
	default:
		return nil
	}

	var obs, sugg string
	if d.isJa() {
		obs, sugg = m.obsJa, m.suggJa
	} else {
		obs, sugg = m.obsEn, m.suggEn
	}

	return &Alert{
		Pattern:     PatternDestructiveCmd,
		Level:       LevelAction,
		Situation:   "Destructive shell command executed",
		Observation: obs,
		Suggestion:  sugg,
		EventCount:  1,
	}
}

// detectFileReadLoop checks for the same file being read repeatedly.
func (d *Detector) detectFileReadLoop() *Alert {
	maxCount := 0
	maxFile := ""
	for f, c := range d.burst.fileReads {
		if c > maxCount {
			maxCount = c
			maxFile = f
		}
	}

	if maxCount < 5 {
		return nil
	}

	level := LevelWarning
	if maxCount >= 8 {
		level = LevelAction
	}

	short := shortPath(maxFile)
	count := itoa(maxCount)
	highBurst := d.burst.toolCount > 15

	var obs, suggestion string
	if d.isJa() {
		obs = short + " を" + count + "回読込済み（編集なし）"
		if highBurst {
			suggestion = "このファイルの何を変更すべきか、具体的に指示してください（例: 関数名、行番号）"
		} else {
			suggestion = "ファイルの内容を理解できていない可能性があります — 変更したい箇所を具体的に伝えてください"
		}
	} else {
		obs = short + " read " + count + " times (no edits)"
		if highBurst {
			suggestion = "Tell Claude specifically what to change in this file (e.g. function name, line number)"
		} else {
			suggestion = "Claude may not understand the file — describe the specific change you want"
		}
	}

	return &Alert{
		Pattern:     PatternFileReadLoop,
		Level:       level,
		Situation:   "Same file read repeatedly without editing",
		Observation: obs,
		Suggestion:  suggestion,
		EventCount:  maxCount,
	}
}

// detectContextThrashing checks for frequent context compactions.
func (d *Detector) detectContextThrashing() *Alert {
	if len(d.compaction.compactTimes) < 2 {
		return nil
	}

	window := 15 * time.Minute
	latest := d.compaction.compactTimes[len(d.compaction.compactTimes)-1]
	compactsInWindow := 0
	for _, ct := range d.compaction.compactTimes {
		if latest.Sub(ct) <= window {
			compactsInWindow++
		}
	}

	if compactsInWindow < 2 {
		return nil
	}

	n := itoa(compactsInWindow)
	var obs, suggestion string
	level := LevelWarning

	if compactsInWindow >= 3 {
		level = LevelAction
		if d.isJa() {
			obs = "15分間に" + n + "回の context compact が発生"
			suggestion = "/clear で新しいセッションを開始してください — タスクを1つに絞り、CLAUDE.md に方針を書いておくと効果的です"
		} else {
			obs = n + " context compactions in 15 minutes"
			suggestion = "Start a new session with /clear — focus on one task and document the approach in CLAUDE.md"
		}
	} else {
		if d.isJa() {
			obs = "15分間に" + n + "回の context compact が発生"
			suggestion = "コンテキストが急速に消費されています — 不要なファイルの読込を避け、スコープを絞ってください"
			if !d.features.SubagentUsed {
				suggestion += "。複雑な調査はサブエージェント (Task) に委任すると本体の context を節約できます"
			}
		} else {
			obs = n + " context compactions in 15 minutes"
			suggestion = "Context filling fast — avoid unnecessary file reads and narrow the scope"
			if !d.features.SubagentUsed {
				suggestion += ". Delegate research to subagents (Task tool) to save main context"
			}
		}
	}

	return &Alert{
		Pattern:     PatternContextThrashing,
		Level:       level,
		Situation:   "Frequent context compactions",
		Observation: obs,
		Suggestion:  suggestion,
		EventCount:  compactsInWindow,
	}
}

// detectTestFailCycle detects test->edit->test fail cycles.
func (d *Detector) detectTestFailCycle(ev parser.SessionEvent) *Alert {
	if ev.Type != parser.EventToolUse {
		return nil
	}

	if ev.ToolName == "Edit" || ev.ToolName == "Write" {
		d.lastEditSeen = true
		return nil
	}

	if ev.ToolName == "Bash" && testCmdPattern.MatchString(ev.ToolInput) {
		if d.lastEditSeen {
			d.testCycleCount++
			d.lastEditSeen = false
		}
	}

	if d.testCycleCount < 2 {
		return nil
	}

	kind := KindAlert
	level := LevelWarning
	if d.testCycleCount == 2 {
		kind = KindProposal
		level = LevelInfo
	}

	count := itoa(d.testCycleCount)
	var obs, suggestion string
	if d.isJa() {
		obs = "テスト→編集→再テストを" + count + "回繰り返してもパスしていません"
		if kind == KindProposal {
			suggestion = "テストが繰り返し失敗しています — 次も失敗したら期待値と実際の出力を貼り付けてみてください"
		} else {
			suggestion = "テストの期待値と実際の出力の差分を貼り付けて、根本原因を特定するよう指示してください"
		}
	} else {
		obs = count + " test-edit-retest cycles without passing"
		if kind == KindProposal {
			suggestion = "Tests failing repeatedly — if the next attempt fails too, paste the expected vs actual output"
		} else {
			suggestion = "Paste the expected vs actual output diff and ask Claude to find the root cause"
		}
	}

	return &Alert{
		Pattern:     PatternTestFailCycle,
		Kind:        kind,
		Level:       level,
		Situation:   "Repeated test-edit-retest cycles",
		Observation: obs,
		Suggestion:  suggestion,
		EventCount:  d.testCycleCount,
	}
}

// detectApologizeRetry detects repeated apologies in assistant text.
func (d *Detector) detectApologizeRetry(ev parser.SessionEvent) *Alert {
	if ev.Type != parser.EventAssistantText {
		return nil
	}

	d.assistantTurnsSinceReset++
	lower := strings.ToLower(ev.AssistantText)
	isApology := false
	for _, kw := range apologyKeywords {
		if strings.Contains(lower, kw) {
			isApology = true
			break
		}
	}

	if isApology {
		d.recentApologies++
		d.lastApologyTime = ev.Timestamp
	}

	if d.recentApologies < 3 || d.assistantTurnsSinceReset > 10 {
		return nil
	}

	turns := itoa(d.assistantTurnsSinceReset)
	apologies := itoa(d.recentApologies)

	var obs, suggestion string
	if d.isJa() {
		obs = "直近" + turns + "ターンで" + apologies + "回謝罪 — 同じアプローチを繰り返しています"
		suggestion = "/clear で仕切り直すか、「期待する結果」と「現在の問題」を分けて伝え直してください"
	} else {
		obs = apologies + " apologies in " + turns + " turns — repeating the same approach"
		suggestion = "Start fresh with /clear, or separately restate the expected outcome and the actual problem"
	}

	return &Alert{
		Pattern:     PatternApologizeRetry,
		Level:       LevelWarning,
		Situation:   "Claude repeatedly apologizing and retrying",
		Observation: obs,
		Suggestion:  suggestion,
		EventCount:  d.recentApologies,
	}
}

// detectExploreLoop detects prolonged read-only exploration without writes.
func (d *Detector) detectExploreLoop() *Alert {
	if d.burst.hasWrite {
		return nil
	}
	if d.burst.toolCount < 10 {
		return nil
	}
	if d.burst.startTime.IsZero() || d.burst.lastToolTime.IsZero() {
		return nil
	}

	elapsed := d.burst.lastToolTime.Sub(d.burst.startTime)
	if elapsed <= 5*time.Minute {
		return nil
	}

	level := LevelWarning
	if elapsed > 7*time.Minute {
		level = LevelAction
	}

	fileCount := len(d.burst.uniqueFiles)
	minutes := itoa(int(elapsed.Minutes()))
	fc := itoa(fileCount)
	topFile := d.topFileRead()
	topShort := shortPath(topFile)
	wideScope := fileCount > 8

	var obs, suggestion string
	if d.isJa() {
		obs = minutes + "分間で" + fc + "ファイルを読込中"
		if topFile != "" {
			obs += "（最多: " + topShort + "）"
		}
		obs += " — 書込なし"

		if wideScope {
			suggestion = "探索範囲が広すぎます — 変更対象のファイルを指定して、具体的な作業を指示してください"
			if !d.features.PlanModeUsed {
				suggestion += "。Plan Mode で方針を決めてから実装に入ると効率的です"
			}
		} else {
			suggestion = "調査が長引いています — 「まず○○を修正して」のように具体的なアクションを指示してください"
		}
	} else {
		obs = minutes + "m exploring " + fc + " files"
		if topFile != "" {
			obs += " (most: " + topShort + ")"
		}
		obs += " — no writes"

		if wideScope {
			suggestion = "Too many files being explored — specify target files and give concrete instructions"
			if !d.features.PlanModeUsed {
				suggestion += ". Use Plan Mode to define the approach before implementation"
			}
		} else {
			suggestion = "Exploration taking too long — give a concrete action like \"first fix X in Y\""
		}
	}

	return &Alert{
		Pattern:     PatternExploreLoop,
		Level:       level,
		Situation:   "Prolonged read-only exploration without writes",
		Observation: obs,
		Suggestion:  suggestion,
		EventCount:  d.burst.toolCount,
	}
}

// detectRateLimitStuck detects being stuck on rate limits.
func (d *Detector) detectRateLimitStuck(ev parser.SessionEvent) *Alert {
	if ev.Type != parser.EventAssistantText {
		return nil
	}

	lower := strings.ToLower(ev.AssistantText)
	hasRateLimit := false
	for _, kw := range rateLimitKeywords {
		if strings.Contains(lower, kw) {
			hasRateLimit = true
			break
		}
	}

	if !hasRateLimit {
		return nil
	}

	recent := d.getRecentFingerprints(10)
	hasProgress := false
	for _, fp := range recent {
		if fp.IsUser || fp.IsWrite {
			hasProgress = true
			break
		}
	}

	if hasProgress || !d.burst.startTime.After(time.Time{}) {
		return nil
	}

	elapsed := ev.Timestamp.Sub(d.burst.startTime)
	if elapsed <= 5*time.Minute {
		return nil
	}

	minutes := itoa(int(elapsed.Minutes()))
	var obs, suggestion string
	if d.isJa() {
		obs = "レート制限が発生し、" + minutes + "分間進捗がありません"
		suggestion = "Esc で中断して数分待ってから再開してください — リトライを続けても解消しません"
	} else {
		obs = "Rate limited with no progress for " + minutes + " minutes"
		suggestion = "Press Esc and wait a few minutes before resuming — continued retries won't help"
	}

	return &Alert{
		Pattern:     PatternRateLimitStuck,
		Level:       LevelAction,
		Situation:   "Rate limited with no progress",
		Observation: obs,
		Suggestion:  suggestion,
		EventCount:  1,
	}
}

// --- Contextual message helpers ---

// shortPath returns filepath.Base, or the original path if Base returns "." or empty.
func shortPath(p string) string {
	b := filepath.Base(p)
	if b == "." || b == "" {
		return p
	}
	return b
}

// topFileRead returns the most-read file path from the current burst.
func (d *Detector) topFileRead() string {
	max, name := 0, ""
	for f, c := range d.burst.fileReads {
		if c > max {
			max, name = c, f
		}
	}
	return name
}

// overlapFiles returns up to n overlapping file names between pre/post compact reads.
func (d *Detector) overlapFiles(n int) []string {
	var result []string
	for f := range d.compaction.postCompactReads {
		if d.compaction.preCompactReads[f] {
			result = append(result, shortPath(f))
			if len(result) >= n {
				break
			}
		}
	}
	return result
}

// --- Feature-aware suggestion builders ---

func (d *Detector) retrySuggestionJa(toolName string, kind FeedbackKind, level FeedbackLevel) string {
	if kind == KindProposal {
		switch toolName {
		case "Edit", "Write":
			return "同じ Edit が繰り返されています — 次も失敗したら行番号で指定すると確実です"
		case "Bash":
			return "同じコマンドを再試行中 — 別のアプローチも検討してみてください"
		default:
			return "同じ操作が繰り返されています — 次も失敗したらアプローチを変えてみてください"
		}
	}
	switch toolName {
	case "Edit", "Write":
		if level >= LevelAction {
			return "Esc で中断して「○行目付近の△△を××に変更して」と具体的に指示してください"
		}
		return "Edit の指定テキストがファイル内容と一致していない可能性があります — 変更箇所を行番号で指定すると確実です"
	case "Bash":
		if level >= LevelAction {
			return "Esc で中断して、別のコマンドか手動での対処を検討してください"
		}
		return "コマンドがエラーを返しています — エラーの原因（パス、権限、依存関係）を伝えてください"
	case "Read", "Grep", "Glob":
		if level >= LevelAction {
			return "Esc で中断して、探しているものの手がかり（ファイル名、関数名）を具体的に伝えてください"
		}
		s := "探しているものを具体的に説明してください（例: 関数名、パターン）"
		if !d.features.SubagentUsed {
			s += "。広範な検索にはサブエージェント (Task) の方が効率的です"
		}
		return s
	default:
		return "Esc で中断して、別のアプローチを指示してください"
	}
}

func (d *Detector) retrySuggestionEn(toolName string, kind FeedbackKind, level FeedbackLevel) string {
	if kind == KindProposal {
		switch toolName {
		case "Edit", "Write":
			return "Same Edit retrying — if it fails again, try specifying by line number"
		case "Bash":
			return "Same command retrying — consider a different approach if it fails again"
		default:
			return "Same operation retrying — consider a different approach if it fails again"
		}
	}
	switch toolName {
	case "Edit", "Write":
		if level >= LevelAction {
			return "Press Esc and tell Claude exactly what to change, e.g. \"change X to Y near line N\""
		}
		return "The target text may not match the file — specify the change by line number for accuracy"
	case "Bash":
		if level >= LevelAction {
			return "Press Esc and try a different command or manual workaround"
		}
		return "The command is failing — describe the error cause (path, permissions, dependencies)"
	case "Read", "Grep", "Glob":
		if level >= LevelAction {
			return "Press Esc and give specific clues: file name, function name, or exact string"
		}
		s := "Describe what you're looking for specifically (e.g. function name, pattern)"
		if !d.features.SubagentUsed {
			s += ". For broad searches, subagents (Task tool) are more efficient"
		}
		return s
	default:
		return "Press Esc and try a different approach"
	}
}

func (d *Detector) excessiveToolsSuggestionJa(fileCount int) string {
	if !d.burst.hasWrite && fileCount > 5 {
		s := "読込だけで書込がありません"
		if !d.features.PlanModeUsed {
			s += " — Plan Mode で方針を決めてから実装に入ると効率的です"
		} else if !d.features.SubagentUsed {
			s += " — 探索はサブエージェント (Task) に委任すると context を節約できます"
		} else {
			s += " — Esc で中断して進捗を確認してください"
		}
		return s
	}
	if fileCount > 10 {
		s := "多数のファイルを変更中"
		if !d.features.CLAUDEMDRead && !d.features.RulesRead {
			s += " — CLAUDE.md や .claude/rules/ にプロジェクトルールを書いておくと一貫性が上がります"
		} else {
			s += " — Esc で中断して進捗を確認してください"
		}
		return s
	}
	return "Esc で中断して、期待する結果に近づいているか確認してください"
}

func (d *Detector) excessiveToolsSuggestionEn(fileCount int) string {
	if !d.burst.hasWrite && fileCount > 5 {
		s := "Read-only with no writes"
		if !d.features.PlanModeUsed {
			s += " — use Plan Mode to define the approach before implementation"
		} else if !d.features.SubagentUsed {
			s += " — delegate exploration to subagents (Task tool) to save context"
		} else {
			s += " — press Esc to check progress"
		}
		return s
	}
	if fileCount > 10 {
		s := "Modifying many files"
		if !d.features.CLAUDEMDRead && !d.features.RulesRead {
			s += " — add project rules to CLAUDE.md or .claude/rules/ for consistency"
		} else {
			s += " — press Esc to check progress"
		}
		return s
	}
	return "Press Esc to check if Claude is making progress toward the goal"
}
