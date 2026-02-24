package analyzer

import (
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

// detectRetryLoop scans last 10 events for 3+ consecutive identical tool calls.
func (d *Detector) detectRetryLoop() *Alert {
	recent := d.getRecentFingerprints(10)
	if len(recent) < 3 {
		return nil
	}

	// Count consecutive identical tool calls (from newest)
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

	if consecutiveCount >= 5 {
		return &Alert{
			Pattern:     PatternRetryLoop,
			Level:       LevelAction,
			Situation:   "Claude is repeating the same tool call",
			Observation: "Same tool+input called " + itoa(consecutiveCount) + " times consecutively",
			Suggestion:  "Interrupt and provide a different approach or clarify the goal",
			EventCount:  consecutiveCount,
		}
	}
	if consecutiveCount >= 3 {
		return &Alert{
			Pattern:     PatternRetryLoop,
			Level:       LevelWarning,
			Situation:   "Claude is repeating the same tool call",
			Observation: "Same tool+input called " + itoa(consecutiveCount) + " times consecutively",
			Suggestion:  "Consider interrupting if the retries don't seem productive",
			EventCount:  consecutiveCount,
		}
	}
	return nil
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
	if ratio > 0.6 {
		d.compaction.inPostCompact = false // only alert once
		return &Alert{
			Pattern:     PatternCompactAmnesia,
			Level:       LevelWarning,
			Situation:   "Context was compacted recently",
			Observation: "Claude is re-reading files it already read before compaction (" + itoa(overlap) + " overlapping)",
			Suggestion:  "Use buddy_recall to recover lost context instead of re-reading files",
			EventCount:  overlap,
		}
	}
	return nil
}

// detectExcessiveTools checks for too many tool calls without user input.
func (d *Detector) detectExcessiveTools() *Alert {
	if d.burst.toolCount >= 40 {
		return &Alert{
			Pattern:     PatternExcessiveTools,
			Level:       LevelAction,
			Situation:   "Long autonomous tool burst",
			Observation: itoa(d.burst.toolCount) + " tool calls without user input",
			Suggestion:  "Interrupt to check progress — Claude may be going in circles",
			EventCount:  d.burst.toolCount,
		}
	}
	if d.burst.toolCount >= 25 {
		return &Alert{
			Pattern:     PatternExcessiveTools,
			Level:       LevelWarning,
			Situation:   "Extended autonomous tool burst",
			Observation: itoa(d.burst.toolCount) + " tool calls without user input",
			Suggestion:  "Check that Claude is making progress toward the goal",
			EventCount:  d.burst.toolCount,
		}
	}
	return nil
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

	var observation string
	switch {
	case rmRFPattern.MatchString(input):
		observation = "Detected rm -rf command"
	case gitPushForcePattern.MatchString(input) && !strings.Contains(input, "--force-with-lease"):
		observation = "Detected git push --force"
	case gitResetHardPattern.MatchString(input):
		observation = "Detected git reset --hard"
	case gitCheckoutDot.MatchString(input):
		observation = "Detected git checkout -- . (discards all changes)"
	case gitRestoreDot.MatchString(input):
		observation = "Detected git restore . (discards all changes)"
	case gitCleanF.MatchString(input):
		observation = "Detected git clean -f (removes untracked files)"
	case gitBranchD.MatchString(input):
		observation = "Detected git branch -D (force delete branch)"
	case chmod777.MatchString(input):
		observation = "Detected chmod 777 (world-writable permissions)"
	default:
		return nil
	}

	return &Alert{
		Pattern:     PatternDestructiveCmd,
		Level:       LevelAction,
		Situation:   "Potentially destructive command executed",
		Observation: observation,
		Suggestion:  "Verify this was intentional — these commands can cause data loss",
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

	if maxCount >= 8 {
		return &Alert{
			Pattern:     PatternFileReadLoop,
			Level:       LevelAction,
			Situation:   "Repeated file reads",
			Observation: maxFile + " read " + itoa(maxCount) + " times without editing",
			Suggestion:  "Claude may be stuck — provide specific guidance about this file",
			EventCount:  maxCount,
		}
	}
	if maxCount >= 5 {
		return &Alert{
			Pattern:     PatternFileReadLoop,
			Level:       LevelWarning,
			Situation:   "Repeated file reads",
			Observation: maxFile + " read " + itoa(maxCount) + " times without editing",
			Suggestion:  "Check if Claude is stuck in a read loop",
			EventCount:  maxCount,
		}
	}
	return nil
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

	if compactsInWindow >= 3 {
		return &Alert{
			Pattern:     PatternContextThrashing,
			Level:       LevelAction,
			Situation:   "Frequent context compactions",
			Observation: itoa(compactsInWindow) + " compactions in 15 minutes",
			Suggestion:  "Context is churning — break the task into smaller steps or start fresh",
			EventCount:  compactsInWindow,
		}
	}
	if compactsInWindow >= 2 {
		return &Alert{
			Pattern:     PatternContextThrashing,
			Level:       LevelWarning,
			Situation:   "Multiple context compactions",
			Observation: itoa(compactsInWindow) + " compactions in 15 minutes",
			Suggestion:  "Session context is filling fast — consider summarizing or narrowing scope",
			EventCount:  compactsInWindow,
		}
	}
	return nil
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

	if d.testCycleCount >= 3 {
		return &Alert{
			Pattern:     PatternTestFailCycle,
			Level:       LevelWarning,
			Situation:   "Test-edit-test cycle detected",
			Observation: itoa(d.testCycleCount) + " test-edit-retest cycles without passing",
			Suggestion:  "Claude may be fixing symptoms, not root cause — describe the expected behavior",
			EventCount:  d.testCycleCount,
		}
	}
	return nil
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

	if d.recentApologies >= 3 && d.assistantTurnsSinceReset <= 10 {
		return &Alert{
			Pattern:     PatternApologizeRetry,
			Level:       LevelWarning,
			Situation:   "Repeated apologies detected",
			Observation: itoa(d.recentApologies) + " apologies in " + itoa(d.assistantTurnsSinceReset) + " assistant turns",
			Suggestion:  "Claude keeps failing and apologizing — try a different approach or rephrase the task",
			EventCount:  d.recentApologies,
		}
	}
	return nil
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

	if elapsed > 7*time.Minute {
		return &Alert{
			Pattern:     PatternExploreLoop,
			Level:       LevelAction,
			Situation:   "Extended read-only exploration",
			Observation: "Over 7 minutes of Read/Grep without any Write/Edit",
			Suggestion:  "Nudge Claude to start making changes or ask what's blocking it",
			EventCount:  d.burst.toolCount,
		}
	}
	if elapsed > 5*time.Minute {
		return &Alert{
			Pattern:     PatternExploreLoop,
			Level:       LevelWarning,
			Situation:   "Prolonged exploration phase",
			Observation: "Over 5 minutes of Read/Grep without any Write/Edit",
			Suggestion:  "Check if Claude needs guidance to start making changes",
			EventCount:  d.burst.toolCount,
		}
	}
	return nil
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

	// Check if no meaningful progress in last few events
	recent := d.getRecentFingerprints(10)
	hasProgress := false
	for _, fp := range recent {
		if fp.IsUser || fp.IsWrite {
			hasProgress = true
			break
		}
	}

	if !hasProgress && d.burst.startTime.After(time.Time{}) {
		elapsed := ev.Timestamp.Sub(d.burst.startTime)
		if elapsed > 5*time.Minute {
			return &Alert{
				Pattern:     PatternRateLimitStuck,
				Level:       LevelAction,
				Situation:   "Rate limit detected with no progress",
				Observation: "Rate limit/overload messages and no productive output for over 5 minutes",
				Suggestion:  "Wait a few minutes or try again later — continued retries won't help",
				EventCount:  1,
			}
		}
	}
	return nil
}
