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
// Threshold: 3 for proposal, 5 for warning, 7+ for action.
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

	if consecutiveCount < 3 {
		return nil
	}

	toolName := recent[0].ToolName
	filePath := recent[0].FilePath
	short := shortPath(filePath)
	count := itoa(consecutiveCount)

	kind := KindAlert
	level := LevelWarning
	switch {
	case consecutiveCount >= 7:
		level = LevelAction
	case consecutiveCount >= 5:
		level = LevelWarning
	default: // 3-4 retries
		kind = KindProposal
		level = LevelInfo
	}

	obs := toolName
	if filePath != "" {
		obs += " → " + short
	}
	obs += " retried " + count + " times consecutively"
	suggestion := d.retrySuggestion(toolName, kind, level)

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

	obs := "Re-reading " + n + " files after compact"
	if len(files) > 0 {
		obs += " (" + fileList
		if overlap > len(files) {
			obs += " etc."
		}
		obs += ")"
	}
	suggestion := "Use buddy_recall to search for pre-compact context — faster than re-reading files"

	return &Alert{
		Pattern:     PatternCompactAmnesia,
		Level:       LevelWarning,
		Situation:   "Files re-read after context compaction",
		Observation: obs,
		Suggestion:  suggestion,
		EventCount:  overlap,
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

	type cmdMsg struct{ obs, sugg string }

	var m cmdMsg
	switch {
	case rmRFPattern.MatchString(input):
		m = cmdMsg{
			"rm -rf command executed",
			"Verify the target path — use git checkout to restore if unintended",
		}
	case gitPushForcePattern.MatchString(input) && !strings.Contains(input, "--force-with-lease"):
		m = cmdMsg{
			"git push --force executed",
			"Remote changes will be overwritten — use --force-with-lease instead",
		}
	case gitResetHardPattern.MatchString(input):
		m = cmdMsg{
			"git reset --hard executed",
			"Uncommitted changes are lost — use git reflog to find previous state",
		}
	case gitCheckoutDot.MatchString(input):
		m = cmdMsg{
			"All working directory changes discarded",
			"Use git stash to save changes before discarding",
		}
	case gitRestoreDot.MatchString(input):
		m = cmdMsg{
			"All working directory changes discarded",
			"Use git stash to save changes before discarding",
		}
	case gitCleanF.MatchString(input):
		m = cmdMsg{
			"git clean -f removed untracked files",
			"Removed files cannot be recovered — use git clean -n to preview first",
		}
	case gitBranchD.MatchString(input):
		m = cmdMsg{
			"git branch -D force-deleted a branch",
			"If unmerged, use git reflog to recover the branch's commits",
		}
	case chmod777.MatchString(input):
		m = cmdMsg{
			"chmod 777 granted world-writable permissions",
			"Security risk — use minimal permissions (644 or 755)",
		}
	default:
		return nil
	}

	return &Alert{
		Pattern:     PatternDestructiveCmd,
		Level:       LevelAction,
		Situation:   "Destructive shell command executed",
		Observation: m.obs,
		Suggestion:  m.sugg,
		EventCount:  1,
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
		obs = n + " context compactions in 15 minutes"
		suggestion = "Start a new session with /clear — focus on one task and document the approach in CLAUDE.md"
	} else {
		obs = n + " context compactions in 15 minutes"
		suggestion = "Context filling fast — avoid unnecessary file reads and narrow the scope"
		if !d.features.SubagentUsed {
			suggestion += ". Delegate research to subagents (Task tool) to save main context"
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
	obs := count + " test-edit-retest cycles without passing"
	var suggestion string
	if kind == KindProposal {
		suggestion = "Tests failing repeatedly — if the next attempt fails too, paste the expected vs actual output"
	} else {
		suggestion = "Paste the expected vs actual output diff and ask Claude to find the root cause"
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

	obs := apologies + " apologies in " + turns + " turns — repeating the same approach"
	suggestion := "Start fresh with /clear, or separately restate the expected outcome and the actual problem"

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
// Suppressed during Plan Mode and when subagents are active.
func (d *Detector) detectExploreLoop() *Alert {
	if d.features.PlanModeActive || d.features.SubagentActive {
		return nil
	}
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
	if elapsed <= 10*time.Minute {
		return nil
	}

	level := LevelWarning
	if elapsed > 15*time.Minute {
		level = LevelAction
	}

	fileCount := len(d.burst.uniqueFiles)
	minutes := itoa(int(elapsed.Minutes()))
	fc := itoa(fileCount)
	topFile := d.topFileRead()
	topShort := shortPath(topFile)
	wideScope := fileCount > 8

	obs := minutes + "m exploring " + fc + " files"
	if topFile != "" {
		obs += " (most: " + topShort + ")"
	}
	obs += " — no writes"

	var suggestion string
	if wideScope {
		suggestion = "Too many files being explored — specify target files and give concrete instructions"
		if !d.features.PlanModeUsed {
			suggestion += ". Use Plan Mode to define the approach before implementation"
		}
	} else {
		suggestion = "Exploration taking too long — give a concrete action like \"first fix X in Y\""
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
	obs := "Rate limited with no progress for " + minutes + " minutes"
	suggestion := "Press Esc and wait a few minutes before resuming — continued retries won't help"

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

func (d *Detector) retrySuggestion(toolName string, kind FeedbackKind, level FeedbackLevel) string {
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

