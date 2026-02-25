package analyzer

import (
	"strings"
	"testing"
	"time"

	"github.com/hir4ta/claude-buddy/internal/parser"
)

func makeToolEvent(name, input string, ts time.Time) parser.SessionEvent {
	return parser.SessionEvent{
		Type:      parser.EventToolUse,
		ToolName:  name,
		ToolInput: input,
		Timestamp: ts,
	}
}

func makeUserEvent(text string, ts time.Time) parser.SessionEvent {
	return parser.SessionEvent{
		Type:      parser.EventUserMessage,
		UserText:  text,
		Timestamp: ts,
	}
}

func makeAssistantEvent(text string, ts time.Time) parser.SessionEvent {
	return parser.SessionEvent{
		Type:          parser.EventAssistantText,
		AssistantText: text,
		Timestamp:     ts,
	}
}

func makeCompactEvent(ts time.Time) parser.SessionEvent {
	return parser.SessionEvent{
		Type:          parser.EventCompactBoundary,
		AssistantText: "Summary of previous context",
		Timestamp:     ts,
	}
}

func TestDetectRetryLoop(t *testing.T) {
	d := NewDetector("en")
	now := time.Now()

	// Start with a user message
	d.Update(makeUserEvent("do something", now))

	// Feed 7 identical Bash events
	var alerts []Alert
	for i := range 7 {
		ts := now.Add(time.Duration(i+1) * time.Second)
		result := d.Update(makeToolEvent("Bash", "ls -la", ts))
		alerts = append(alerts, result...)
	}

	// Should get proposal at 3, warning at 5, action at 7
	var hasProposal, hasWarning bool
	for _, a := range alerts {
		if a.Pattern == PatternRetryLoop {
			if a.Kind == KindProposal {
				hasProposal = true
			}
			if a.Level >= LevelWarning {
				hasWarning = true
			}
		}
	}
	if !hasProposal {
		t.Error("expected proposal at 3 retries")
	}
	if !hasWarning {
		t.Error("expected warning/action at 5+ retries")
	}
}

func TestDetectRetryLoopFalsePositive(t *testing.T) {
	d := NewDetector("en")
	now := time.Now()

	d.Update(makeUserEvent("do something", now))

	// Feed 2 identical reads, then an Edit, then 2 more reads
	d.Update(makeToolEvent("Read", "/foo/bar.go", now.Add(1*time.Second)))
	d.Update(makeToolEvent("Read", "/foo/bar.go", now.Add(2*time.Second)))
	d.Update(makeToolEvent("Edit", "/foo/bar.go", now.Add(3*time.Second)))
	alerts3 := d.Update(makeToolEvent("Read", "/foo/bar.go", now.Add(4*time.Second)))
	alerts4 := d.Update(makeToolEvent("Read", "/foo/bar.go", now.Add(5*time.Second)))

	// Should NOT trigger retry loop (the Edit breaks the consecutive chain)
	for _, a := range append(alerts3, alerts4...) {
		if a.Pattern == PatternRetryLoop {
			t.Error("expected no retry-loop alert when Edit breaks the chain")
		}
	}
}

func TestDetectDestructiveCmd(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantHit bool
	}{
		{"rm -rf", "rm -rf /tmp/foo", true},
		{"rm -fr", "rm -fr /tmp", true},
		{"rm -r -f", "rm -rf somedir", true},
		{"git push --force", "git push --force origin main", true},
		{"git push -f", "git push -f origin main", true},
		{"git reset --hard", "git reset --hard HEAD~1", true},
		{"git checkout -- .", "git checkout -- .", true},
		{"git restore .", "git restore .", true},
		{"git clean -f", "git clean -f", true},
		{"git clean -fd", "git clean -fd", true},
		{"git branch -D", "git branch -D feature", true},
		{"chmod 777", "chmod 777 /tmp/file", true},
		{"safe rm", "rm file.txt", false},
		{"git push normal", "git push origin main", false},
		{"force-with-lease", "git push --force-with-lease origin main", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := NewDetector("en")
			now := time.Now()
			d.Update(makeUserEvent("test", now))

			alerts := d.Update(makeToolEvent("Bash", tt.input, now.Add(time.Second)))
			gotHit := false
			for _, a := range alerts {
				if a.Pattern == PatternDestructiveCmd {
					gotHit = true
					if a.Level != LevelAction {
						t.Errorf("expected Action level, got %d", a.Level)
					}
				}
			}
			if gotHit != tt.wantHit {
				t.Errorf("input=%q: gotHit=%v, wantHit=%v", tt.input, gotHit, tt.wantHit)
			}
		})
	}
}

func TestDetectDestructiveCmdSafe(t *testing.T) {
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("test", now))

	alerts := d.Update(makeToolEvent("Bash", "rm file.txt", now.Add(time.Second)))
	for _, a := range alerts {
		if a.Pattern == PatternDestructiveCmd {
			t.Error("expected no destructive-cmd alert for safe rm")
		}
	}
}

func TestDetectContextThrashing(t *testing.T) {
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("start", now))

	// 3 compacts within 10 minutes
	var alerts []Alert
	for i := range 3 {
		ts := now.Add(time.Duration(i*4) * time.Minute)
		result := d.Update(makeCompactEvent(ts))
		alerts = append(alerts, result...)
	}

	foundWarning := false
	foundAction := false
	for _, a := range alerts {
		if a.Pattern == PatternContextThrashing {
			if a.Level == LevelWarning {
				foundWarning = true
			}
			if a.Level == LevelAction {
				foundAction = true
			}
		}
	}
	if !foundWarning {
		t.Error("expected context-thrashing warning after 2 compacts")
	}
	if !foundAction {
		t.Error("expected context-thrashing action after 3 compacts")
	}
}

func TestDetectExploreLoop(t *testing.T) {
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("explore codebase", now))

	var alerts []Alert
	// 20 Read/Grep events over 11 minutes without Write
	for i := range 20 {
		ts := now.Add(time.Duration(i*33) * time.Second) // spread over ~11 minutes
		toolName := "Read"
		if i%3 == 0 {
			toolName = "Grep"
		}
		result := d.Update(makeToolEvent(toolName, "/file"+itoa(i)+".go", ts))
		alerts = append(alerts, result...)
	}

	found := false
	for _, a := range alerts {
		if a.Pattern == PatternExploreLoop && a.Level >= LevelWarning {
			found = true
		}
	}
	if !found {
		t.Error("expected explore-loop warning after 10+ min of reads without writes")
	}
}

func TestDetectCompactAmnesia(t *testing.T) {
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("start", now))

	// Read files A, B, C before compact
	d.Update(makeToolEvent("Read", "/a.go", now.Add(1*time.Second)))
	d.Update(makeToolEvent("Read", "/b.go", now.Add(2*time.Second)))
	d.Update(makeToolEvent("Read", "/c.go", now.Add(3*time.Second)))

	// Compact boundary
	d.Update(makeCompactEvent(now.Add(4 * time.Second)))

	// Re-read same files A, B, C after compact + additional events to reach 30 threshold
	var alerts []Alert
	d.Update(makeToolEvent("Read", "/a.go", now.Add(5*time.Second)))
	d.Update(makeToolEvent("Read", "/b.go", now.Add(6*time.Second)))
	d.Update(makeToolEvent("Read", "/c.go", now.Add(7*time.Second)))

	// Fill up to 30 post-compact events
	for i := range 27 {
		ts := now.Add(time.Duration(8+i) * time.Second)
		result := d.Update(makeToolEvent("Bash", "echo "+itoa(i), ts))
		alerts = append(alerts, result...)
	}

	found := false
	for _, a := range alerts {
		if a.Pattern == PatternCompactAmnesia {
			found = true
		}
	}
	if !found {
		t.Error("expected compact-amnesia alert when re-reading same files after compact")
	}
}

func TestCooldown(t *testing.T) {
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("test", now))

	// Trigger destructive cmd alert
	alerts1 := d.Update(makeToolEvent("Bash", "rm -rf /tmp", now.Add(1*time.Second)))
	if len(alerts1) == 0 {
		t.Fatal("expected alert on first destructive cmd")
	}

	// Immediately trigger same pattern — should be suppressed by cooldown
	alerts2 := d.Update(makeToolEvent("Bash", "rm -rf /other", now.Add(2*time.Second)))
	for _, a := range alerts2 {
		if a.Pattern == PatternDestructiveCmd {
			t.Error("expected destructive-cmd alert to be suppressed by cooldown")
		}
	}
}

func TestSessionHealth(t *testing.T) {
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("test", now))

	// Before any alerts
	if h := d.SessionHealth(); h != 1.0 {
		t.Errorf("expected health 1.0 before alerts, got %f", h)
	}

	// Trigger a Warning-level alert
	d.Update(makeToolEvent("Bash", "rm -rf /tmp", now.Add(1*time.Second)))

	// Health should decrease
	h := d.SessionHealth()
	if h >= 1.0 {
		t.Errorf("expected health < 1.0 after alert, got %f", h)
	}
	if h < 0 {
		t.Errorf("expected health >= 0, got %f", h)
	}
}

func TestPatternName(t *testing.T) {
	tests := []struct {
		pattern PatternType
		want    string
	}{
		{PatternRetryLoop, "retry-loop"},
		{PatternCompactAmnesia, "compact-amnesia"},
		{PatternExcessiveTools, "excessive-tools"},
		{PatternDestructiveCmd, "destructive-cmd"},
		{PatternFileReadLoop, "file-read-loop"},
		{PatternContextThrashing, "context-thrashing"},
		{PatternTestFailCycle, "test-fail-cycle"},
		{PatternApologizeRetry, "apologize-retry"},
		{PatternExploreLoop, "explore-loop"},
		{PatternRateLimitStuck, "rate-limit-stuck"},
	}
	for _, tt := range tests {
		got := PatternName(tt.pattern)
		if got != tt.want {
			t.Errorf("PatternName(%d) = %q, want %q", tt.pattern, got, tt.want)
		}
	}
}

func TestNewDetectorInitialization(t *testing.T) {
	d := NewDetector("en")
	if d == nil {
		t.Fatal("NewDetector returned nil")
	}
	if len(d.window) != windowCapacity {
		t.Errorf("window size = %d, want %d", len(d.window), windowCapacity)
	}
	if d.cooldowns == nil {
		t.Error("cooldowns map not initialized")
	}
	if d.burst.fileReads == nil {
		t.Error("burst.fileReads map not initialized")
	}
}

func TestDetectApologizeRetry(t *testing.T) {
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("fix this bug", now))

	var alerts []Alert
	apologyTexts := []string{
		"I apologize for the confusion. Let me try again.",
		"Sorry about that, I made an error. Let me fix this.",
		"My mistake, I should have done it differently. Let me fix this.",
	}
	for i, text := range apologyTexts {
		ts := now.Add(time.Duration(i+1) * time.Second)
		result := d.Update(makeAssistantEvent(text, ts))
		alerts = append(alerts, result...)
	}

	found := false
	for _, a := range alerts {
		if a.Pattern == PatternApologizeRetry {
			found = true
		}
	}
	if !found {
		t.Error("expected apologize-retry alert after 3 apologies")
	}
}

func TestDetectTestFailCycle(t *testing.T) {
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("fix test", now))

	var alerts []Alert
	for i := range 3 {
		offset := time.Duration(i*3) * time.Second
		d.Update(makeToolEvent("Edit", "/test_file.go", now.Add(offset+1*time.Second)))
		result := d.Update(makeToolEvent("Bash", "go test ./...", now.Add(offset+2*time.Second)))
		alerts = append(alerts, result...)
	}

	found := false
	for _, a := range alerts {
		if a.Pattern == PatternTestFailCycle {
			found = true
		}
	}
	if !found {
		t.Error("expected test-fail-cycle alert after 3 edit-test cycles")
	}
}

// --- Contextual message content tests (English locale) ---

func TestRetryLoopMessageEditFile(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("fix this", now))

	var alerts []Alert
	for i := range 7 {
		ts := now.Add(time.Duration(i+1) * time.Second)
		result := d.Update(makeToolEvent("Edit", "/proj/src/store.go", ts))
		alerts = append(alerts, result...)
	}

	// Check escalation: Proposal → Warning → Action
	var hasProposal, hasWarning, hasAction bool
	for _, a := range alerts {
		if a.Pattern != PatternRetryLoop {
			continue
		}
		if !strings.Contains(a.Observation, "Edit") {
			t.Errorf("Observation should contain tool name 'Edit', got: %s", a.Observation)
		}
		if !strings.Contains(a.Observation, "store.go") {
			t.Errorf("Observation should contain short file name 'store.go', got: %s", a.Observation)
		}
		switch {
		case a.Kind == KindProposal:
			hasProposal = true
			if !strings.Contains(a.Suggestion, "Same Edit") {
				t.Errorf("Proposal for Edit should mention Same Edit, got: %s", a.Suggestion)
			}
		case a.Level == LevelWarning:
			hasWarning = true
			if !strings.Contains(a.Suggestion, "target text") {
				t.Errorf("Warning for Edit should mention target text, got: %s", a.Suggestion)
			}
		case a.Level == LevelAction:
			hasAction = true
			if !strings.Contains(a.Suggestion, "line") {
				t.Errorf("Action for Edit should mention line, got: %s", a.Suggestion)
			}
		}
	}
	if !hasProposal {
		t.Error("expected proposal at 3 retries")
	}
	if !hasWarning {
		t.Error("expected warning at 5 retries")
	}
	if !hasAction {
		t.Error("expected action at 7 retries")
	}
}

func TestRetryLoopMessageBash(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("run it", now))

	var alerts []Alert
	for i := range 7 {
		ts := now.Add(time.Duration(i+1) * time.Second)
		result := d.Update(makeToolEvent("Bash", "npm test", ts))
		alerts = append(alerts, result...)
	}

	var hasWarning, hasAction bool
	for _, a := range alerts {
		if a.Pattern != PatternRetryLoop {
			continue
		}
		if !strings.Contains(a.Observation, "Bash") {
			t.Errorf("Observation should contain 'Bash', got: %s", a.Observation)
		}
		switch {
		case a.Level == LevelWarning && a.Kind == KindAlert:
			hasWarning = true
			if !strings.Contains(a.Suggestion, "failing") {
				t.Errorf("Warning for Bash should mention failing, got: %s", a.Suggestion)
			}
		case a.Level == LevelAction:
			hasAction = true
			if !strings.Contains(a.Suggestion, "different") {
				t.Errorf("Action for Bash should mention different, got: %s", a.Suggestion)
			}
		}
	}
	if !hasWarning {
		t.Error("expected warning at 5 retries")
	}
	if !hasAction {
		t.Error("expected action at 7 retries")
	}
}

func TestExploreLoopTopFile(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("explore", now))

	var alerts []Alert
	for i := range 20 {
		ts := now.Add(time.Duration(i*33) * time.Second) // spread over ~11 minutes
		var result []Alert
		if i%2 == 0 {
			result = d.Update(makeToolEvent("Read", "/proj/main.go", ts))
		} else {
			result = d.Update(makeToolEvent("Grep", "/proj/file"+itoa(i)+".go", ts))
		}
		alerts = append(alerts, result...)
	}

	for _, a := range alerts {
		if a.Pattern == PatternExploreLoop {
			if !strings.Contains(a.Observation, "main.go") {
				t.Errorf("Observation should contain top file 'main.go', got: %s", a.Observation)
			}
			if !strings.Contains(a.Observation, "no writes") {
				t.Errorf("Observation should indicate no writes, got: %s", a.Observation)
			}
			return
		}
	}
	t.Error("expected explore-loop alert")
}

func TestCompactAmnesiaFileList(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("start", now))

	d.Update(makeToolEvent("Read", "/proj/alpha.go", now.Add(1*time.Second)))
	d.Update(makeToolEvent("Read", "/proj/beta.go", now.Add(2*time.Second)))
	d.Update(makeToolEvent("Read", "/proj/gamma.go", now.Add(3*time.Second)))

	d.Update(makeCompactEvent(now.Add(4 * time.Second)))

	d.Update(makeToolEvent("Read", "/proj/alpha.go", now.Add(5*time.Second)))
	d.Update(makeToolEvent("Read", "/proj/beta.go", now.Add(6*time.Second)))
	d.Update(makeToolEvent("Read", "/proj/gamma.go", now.Add(7*time.Second)))

	var alerts []Alert
	for i := range 27 {
		ts := now.Add(time.Duration(8+i) * time.Second)
		result := d.Update(makeToolEvent("Bash", "echo "+itoa(i), ts))
		alerts = append(alerts, result...)
	}

	for _, a := range alerts {
		if a.Pattern == PatternCompactAmnesia {
			hasFile := strings.Contains(a.Observation, "alpha.go") ||
				strings.Contains(a.Observation, "beta.go") ||
				strings.Contains(a.Observation, "gamma.go")
			if !hasFile {
				t.Errorf("Observation should contain overlapping file names, got: %s", a.Observation)
			}
			if !strings.Contains(a.Suggestion, "buddy_recall") {
				t.Errorf("Suggestion should mention buddy_recall, got: %s", a.Suggestion)
			}
			return
		}
	}
	t.Error("expected compact-amnesia alert")
}

func TestDestructiveCmdSpecificSuggestions(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		input      string
		wantInObs  string
		wantInSugg string
	}{
		{"rm-rf", "rm -rf /tmp/foo", "rm -rf", "git checkout"},
		{"push-force", "git push --force origin main", "push --force", "--force-with-lease"},
		{"reset-hard", "git reset --hard HEAD~1", "reset --hard", "git reflog"},
		{"checkout-dot", "git checkout -- .", "changes discarded", "git stash"},
		{"clean-f", "git clean -f", "untracked files", "git clean -n"},
		{"branch-D", "git branch -D feature", "force-deleted", "git reflog"},
		{"chmod-777", "chmod 777 /tmp/file", "chmod 777", "644 or 755"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			d := NewDetector("en")
			now := time.Now()
			d.Update(makeUserEvent("test", now))

			alerts := d.Update(makeToolEvent("Bash", tt.input, now.Add(time.Second)))
			for _, a := range alerts {
				if a.Pattern == PatternDestructiveCmd {
					if !strings.Contains(a.Observation, tt.wantInObs) {
						t.Errorf("Observation = %q, want containing %q", a.Observation, tt.wantInObs)
					}
					if !strings.Contains(a.Suggestion, tt.wantInSugg) {
						t.Errorf("Suggestion = %q, want containing %q", a.Suggestion, tt.wantInSugg)
					}
					return
				}
			}
			t.Errorf("expected destructive-cmd alert for input %q", tt.input)
		})
	}
}

func TestContextThrashingSuggestion(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("start", now))

	var alerts []Alert
	for i := range 3 {
		ts := now.Add(time.Duration(i*4) * time.Minute)
		result := d.Update(makeCompactEvent(ts))
		alerts = append(alerts, result...)
	}

	for _, a := range alerts {
		if a.Pattern == PatternContextThrashing && a.Level == LevelAction {
			if !strings.Contains(a.Suggestion, "/clear") {
				t.Errorf("Action-level suggestion should mention /clear, got: %s", a.Suggestion)
			}
			if !strings.Contains(a.Suggestion, "CLAUDE.md") {
				t.Errorf("Action-level suggestion should mention CLAUDE.md, got: %s", a.Suggestion)
			}
			return
		}
	}
	t.Error("expected context-thrashing action alert")
}

func TestApologizeRetryMessage(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("fix bug", now))

	var alerts []Alert
	texts := []string{
		"I apologize for the confusion.",
		"Sorry about that, let me try again.",
		"My mistake, I should have done it differently.",
	}
	for i, text := range texts {
		ts := now.Add(time.Duration(i+1) * time.Second)
		result := d.Update(makeAssistantEvent(text, ts))
		alerts = append(alerts, result...)
	}

	for _, a := range alerts {
		if a.Pattern == PatternApologizeRetry {
			if !strings.Contains(a.Observation, "apologies") {
				t.Errorf("Observation should mention apologies, got: %s", a.Observation)
			}
			if !strings.Contains(a.Observation, "turns") {
				t.Errorf("Observation should mention turns, got: %s", a.Observation)
			}
			if !strings.Contains(a.Suggestion, "/clear") {
				t.Errorf("Suggestion should mention /clear, got: %s", a.Suggestion)
			}
			if !strings.Contains(a.Suggestion, "expected outcome") {
				t.Errorf("Suggestion should mention expected outcome, got: %s", a.Suggestion)
			}
			return
		}
	}
	t.Error("expected apologize-retry alert")
}

func TestTestFailCycleMessage(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("fix test", now))

	var alerts []Alert
	for i := range 3 {
		offset := time.Duration(i*3) * time.Second
		d.Update(makeToolEvent("Edit", "/test.go", now.Add(offset+1*time.Second)))
		result := d.Update(makeToolEvent("Bash", "go test ./...", now.Add(offset+2*time.Second)))
		alerts = append(alerts, result...)
	}

	var hasProposal, hasWarning bool
	for _, a := range alerts {
		if a.Pattern != PatternTestFailCycle {
			continue
		}
		if !strings.Contains(a.Observation, "test-edit-retest") {
			t.Errorf("Observation should describe the cycle, got: %s", a.Observation)
		}
		if a.Kind == KindProposal {
			hasProposal = true
		}
		if a.Kind == KindAlert && a.Level == LevelWarning {
			hasWarning = true
			if !strings.Contains(a.Suggestion, "root cause") {
				t.Errorf("Warning suggestion should mention root cause, got: %s", a.Suggestion)
			}
		}
	}
	if !hasProposal {
		t.Error("expected proposal at 2 cycles")
	}
	if !hasWarning {
		t.Error("expected warning at 3 cycles")
	}
}

// --- Japanese locale tests ---

func TestRetryLoopMessageJa(t *testing.T) {
	t.Parallel()
	d := NewDetector("ja")
	now := time.Now()
	d.Update(makeUserEvent("直して", now))

	var alerts []Alert
	for i := range 7 {
		ts := now.Add(time.Duration(i+1) * time.Second)
		result := d.Update(makeToolEvent("Edit", "/proj/src/store.go", ts))
		alerts = append(alerts, result...)
	}

	// Check each escalation stage: Proposal → Warning → Action
	var hasProposal, hasWarning, hasAction bool
	for _, a := range alerts {
		if a.Pattern != PatternRetryLoop {
			continue
		}
		if !strings.Contains(a.Observation, "連続リトライ中") {
			t.Errorf("Observation should be in Japanese, got: %s", a.Observation)
		}
		switch {
		case a.Kind == KindProposal:
			hasProposal = true
			if !strings.Contains(a.Suggestion, "同じ Edit") {
				t.Errorf("Proposal suggestion should mention 同じ Edit, got: %s", a.Suggestion)
			}
		case a.Level == LevelWarning:
			hasWarning = true
			if !strings.Contains(a.Suggestion, "指定テキスト") {
				t.Errorf("Warning suggestion should mention 指定テキスト, got: %s", a.Suggestion)
			}
		case a.Level == LevelAction:
			hasAction = true
			if !strings.Contains(a.Suggestion, "行目") {
				t.Errorf("Action suggestion should mention 行目, got: %s", a.Suggestion)
			}
		}
	}
	if !hasProposal {
		t.Error("expected proposal at 3 retries")
	}
	if !hasWarning {
		t.Error("expected warning at 5 retries")
	}
	if !hasAction {
		t.Error("expected action at 7 retries")
	}
}

func TestDestructiveCmdJa(t *testing.T) {
	t.Parallel()
	d := NewDetector("ja")
	now := time.Now()
	d.Update(makeUserEvent("test", now))

	alerts := d.Update(makeToolEvent("Bash", "rm -rf /tmp/foo", now.Add(time.Second)))
	for _, a := range alerts {
		if a.Pattern == PatternDestructiveCmd {
			if !strings.Contains(a.Observation, "rm -rf が実行されました") {
				t.Errorf("Observation should be in Japanese, got: %s", a.Observation)
			}
			if !strings.Contains(a.Suggestion, "git checkout で復元") {
				t.Errorf("Suggestion should be in Japanese, got: %s", a.Suggestion)
			}
			return
		}
	}
	t.Error("expected destructive-cmd alert")
}

func TestApologizeRetryMessageJa(t *testing.T) {
	t.Parallel()
	d := NewDetector("ja")
	now := time.Now()
	d.Update(makeUserEvent("修正して", now))

	var alerts []Alert
	texts := []string{
		"I apologize for the confusion.",
		"Sorry about that, let me try again.",
		"My mistake, I should have done it differently.",
	}
	for i, text := range texts {
		ts := now.Add(time.Duration(i+1) * time.Second)
		result := d.Update(makeAssistantEvent(text, ts))
		alerts = append(alerts, result...)
	}

	for _, a := range alerts {
		if a.Pattern == PatternApologizeRetry {
			if !strings.Contains(a.Observation, "回謝罪") {
				t.Errorf("Observation should be in Japanese, got: %s", a.Observation)
			}
			if !strings.Contains(a.Suggestion, "/clear") {
				t.Errorf("Suggestion should mention /clear, got: %s", a.Suggestion)
			}
			return
		}
	}
	t.Error("expected apologize-retry alert")
}

// --- Feature tracking tests ---

func TestFeatureTrackingPlanMode(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()

	if d.Features().PlanModeUsed {
		t.Error("PlanModeUsed should be false initially")
	}

	d.Update(makeUserEvent("plan", now))
	d.Update(makeToolEvent("EnterPlanMode", "", now.Add(time.Second)))

	if !d.Features().PlanModeUsed {
		t.Error("PlanModeUsed should be true after EnterPlanMode")
	}
}

func TestFeatureTrackingSubagent(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()

	d.Update(makeUserEvent("research", now))
	d.Update(makeToolEvent("Task", "explore codebase", now.Add(time.Second)))

	if !d.Features().SubagentUsed {
		t.Error("SubagentUsed should be true after Task tool")
	}
}

func TestFeatureTrackingAgentSpawn(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()

	d.Update(makeUserEvent("delegate", now))
	d.Update(parser.SessionEvent{
		Type:      parser.EventAgentSpawn,
		AgentName: "researcher",
		Timestamp: now.Add(time.Second),
	})

	if !d.Features().SubagentUsed {
		t.Error("SubagentUsed should be true after AgentSpawn")
	}
}

func TestFeatureTrackingCLAUDEMD(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()

	d.Update(makeUserEvent("start", now))
	d.Update(makeToolEvent("Read", "/proj/CLAUDE.md", now.Add(time.Second)))

	if !d.Features().CLAUDEMDRead {
		t.Error("CLAUDEMDRead should be true after reading CLAUDE.md")
	}
}

func TestFeatureTrackingRules(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()

	d.Update(makeUserEvent("start", now))
	d.Update(makeToolEvent("Read", "/proj/.claude/rules/go-style.md", now.Add(time.Second)))

	if !d.Features().RulesRead {
		t.Error("RulesRead should be true after reading .claude/rules/")
	}
}

func TestFeatureTrackingSkill(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()

	d.Update(makeUserEvent("commit", now))
	d.Update(makeToolEvent("Skill", "commit", now.Add(time.Second)))

	if !d.Features().SkillUsed {
		t.Error("SkillUsed should be true after Skill tool")
	}
}

// --- Feature-aware suggestion tests ---

func TestContextThrashingSuggestsSubagent(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("start", now))

	// 2 compacts in 15 min → Warning level suggests subagents
	var alerts []Alert
	for i := range 2 {
		ts := now.Add(time.Duration(i*4) * time.Minute)
		result := d.Update(makeCompactEvent(ts))
		alerts = append(alerts, result...)
	}

	for _, a := range alerts {
		if a.Pattern == PatternContextThrashing && a.Level == LevelWarning {
			if !strings.Contains(a.Suggestion, "subagent") {
				t.Errorf("Warning-level should suggest subagents when unused, got: %s", a.Suggestion)
			}
			return
		}
	}
	t.Error("expected context-thrashing warning alert")
}

func TestRetryLoopSuggestsSubagentForGrep(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("find it", now))

	var alerts []Alert
	for i := range 5 {
		ts := now.Add(time.Duration(i+1) * time.Second)
		result := d.Update(makeToolEvent("Grep", "searchPattern", ts))
		alerts = append(alerts, result...)
	}

	// Warning-level suggestion for Grep should mention subagents
	found := false
	for _, a := range alerts {
		if a.Pattern == PatternRetryLoop && a.Kind == KindAlert && a.Level == LevelWarning {
			found = true
			if !strings.Contains(a.Suggestion, "subagent") {
				t.Errorf("Grep retry warning should suggest subagents when unused, got: %s", a.Suggestion)
			}
		}
	}
	if !found {
		t.Error("expected warning-level retry-loop alert for Grep")
	}
}

// --- Alert selection tests (v2: group-based dedup via SelectTopAlerts) ---

func TestSelectTopAlertsGroupDedup(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("do work", now))

	// Feed 7+ identical tool calls → triggers retry-loop
	var allAlerts []Alert
	for i := range 10 {
		ts := now.Add(time.Duration(i+1) * time.Second)
		result := d.Update(makeToolEvent("Read", "/same/file.go", ts))
		allAlerts = append(allAlerts, result...)
	}

	// retry-loop should fire from the detector
	hasRetryLoop := false
	for _, a := range allAlerts {
		if a.Pattern == PatternRetryLoop {
			hasRetryLoop = true
		}
	}
	if !hasRetryLoop {
		t.Error("expected retry-loop to fire")
	}

	// SelectTopAlerts should keep only one per group
	selected := SelectTopAlerts(allAlerts, 3)
	groups := make(map[AlertGroup]int)
	for _, a := range selected {
		groups[groupFor(a.Pattern)]++
	}
	for g, count := range groups {
		if count > 1 {
			t.Errorf("group %d has %d alerts, expected at most 1", g, count)
		}
	}
}

// --- Rate limit stuck tests ---

func TestDetectRateLimitStuck(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("do work", now))

	// Build up a burst with no user messages or writes (no progress)
	for i := range 10 {
		ts := now.Add(time.Duration(i+1) * time.Second)
		d.Update(makeToolEvent("Read", "/file"+itoa(i)+".go", ts))
	}

	// Assistant text with rate limit keyword after 6 minutes (>5min threshold)
	var alerts []Alert
	result := d.Update(makeAssistantEvent("Got rate limit error 429, retrying...", now.Add(6*time.Minute)))
	alerts = append(alerts, result...)

	found := false
	for _, a := range alerts {
		if a.Pattern == PatternRateLimitStuck {
			found = true
			if a.Level != LevelAction {
				t.Errorf("expected LevelAction, got %d", a.Level)
			}
			if !strings.Contains(a.Observation, "6 minutes") {
				t.Errorf("Observation should mention elapsed time, got: %s", a.Observation)
			}
			if !strings.Contains(a.Suggestion, "Esc") {
				t.Errorf("Suggestion should mention Esc, got: %s", a.Suggestion)
			}
		}
	}
	if !found {
		t.Error("expected rate-limit-stuck alert after 5+ min with no progress")
	}
}

func TestDetectRateLimitStuckNotTriggeredWithProgress(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("do work", now))

	// Write event = progress
	d.Update(makeToolEvent("Edit", "/file.go", now.Add(time.Second)))

	// Rate limit text after 6 minutes, but there was a write (progress)
	alerts := d.Update(makeAssistantEvent("Got rate limit error 429", now.Add(6*time.Minute)))

	for _, a := range alerts {
		if a.Pattern == PatternRateLimitStuck {
			t.Error("should not trigger rate-limit-stuck when there's recent progress (write)")
		}
	}
}

func TestDetectRateLimitStuckNotTriggeredEarly(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("do work", now))

	for i := range 5 {
		d.Update(makeToolEvent("Read", "/file"+itoa(i)+".go", now.Add(time.Duration(i+1)*time.Second)))
	}

	// Rate limit text at only 3 minutes (under 5min threshold)
	alerts := d.Update(makeAssistantEvent("Got rate limit error 429", now.Add(3*time.Minute)))

	for _, a := range alerts {
		if a.Pattern == PatternRateLimitStuck {
			t.Error("should not trigger rate-limit-stuck before 5 minutes")
		}
	}
}

func TestDetectRateLimitStuckJa(t *testing.T) {
	t.Parallel()
	d := NewDetector("ja")
	now := time.Now()
	d.Update(makeUserEvent("作業", now))

	for i := range 10 {
		d.Update(makeToolEvent("Read", "/file"+itoa(i)+".go", now.Add(time.Duration(i+1)*time.Second)))
	}

	alerts := d.Update(makeAssistantEvent("Got 429 rate limit error", now.Add(6*time.Minute)))

	for _, a := range alerts {
		if a.Pattern == PatternRateLimitStuck {
			if !strings.Contains(a.Observation, "レート制限") {
				t.Errorf("Japanese observation expected, got: %s", a.Observation)
			}
			if !strings.Contains(a.Suggestion, "Esc") {
				t.Errorf("Suggestion should mention Esc, got: %s", a.Suggestion)
			}
			return
		}
	}
	t.Error("expected rate-limit-stuck alert in Japanese")
}

// --- Missing Japanese locale tests ---

func TestCompactAmnesiaJa(t *testing.T) {
	t.Parallel()
	d := NewDetector("ja")
	now := time.Now()
	d.Update(makeUserEvent("開始", now))

	d.Update(makeToolEvent("Read", "/proj/alpha.go", now.Add(1*time.Second)))
	d.Update(makeToolEvent("Read", "/proj/beta.go", now.Add(2*time.Second)))
	d.Update(makeToolEvent("Read", "/proj/gamma.go", now.Add(3*time.Second)))

	d.Update(makeCompactEvent(now.Add(4 * time.Second)))

	d.Update(makeToolEvent("Read", "/proj/alpha.go", now.Add(5*time.Second)))
	d.Update(makeToolEvent("Read", "/proj/beta.go", now.Add(6*time.Second)))
	d.Update(makeToolEvent("Read", "/proj/gamma.go", now.Add(7*time.Second)))

	var alerts []Alert
	for i := range 27 {
		ts := now.Add(time.Duration(8+i) * time.Second)
		result := d.Update(makeToolEvent("Bash", "echo "+itoa(i), ts))
		alerts = append(alerts, result...)
	}

	for _, a := range alerts {
		if a.Pattern == PatternCompactAmnesia {
			if !strings.Contains(a.Observation, "compact 後に") {
				t.Errorf("Japanese observation expected, got: %s", a.Observation)
			}
			if !strings.Contains(a.Suggestion, "buddy_recall") {
				t.Errorf("Suggestion should mention buddy_recall, got: %s", a.Suggestion)
			}
			return
		}
	}
	t.Error("expected compact-amnesia alert in Japanese")
}

func TestContextThrashingJa(t *testing.T) {
	t.Parallel()
	d := NewDetector("ja")
	now := time.Now()
	d.Update(makeUserEvent("開始", now))

	var alerts []Alert
	for i := range 3 {
		ts := now.Add(time.Duration(i*4) * time.Minute)
		result := d.Update(makeCompactEvent(ts))
		alerts = append(alerts, result...)
	}

	for _, a := range alerts {
		if a.Pattern == PatternContextThrashing && a.Level == LevelAction {
			if !strings.Contains(a.Observation, "context compact") {
				t.Errorf("Japanese observation expected, got: %s", a.Observation)
			}
			if !strings.Contains(a.Suggestion, "/clear") {
				t.Errorf("Suggestion should mention /clear, got: %s", a.Suggestion)
			}
			return
		}
	}
	t.Error("expected context-thrashing action alert in Japanese")
}

func TestTestFailCycleJa(t *testing.T) {
	t.Parallel()
	d := NewDetector("ja")
	now := time.Now()
	d.Update(makeUserEvent("テスト直して", now))

	var alerts []Alert
	for i := range 3 {
		offset := time.Duration(i*3) * time.Second
		d.Update(makeToolEvent("Edit", "/test.go", now.Add(offset+1*time.Second)))
		result := d.Update(makeToolEvent("Bash", "go test ./...", now.Add(offset+2*time.Second)))
		alerts = append(alerts, result...)
	}

	var hasProposal, hasWarning bool
	for _, a := range alerts {
		if a.Pattern != PatternTestFailCycle {
			continue
		}
		if !strings.Contains(a.Observation, "テスト→編集→再テスト") {
			t.Errorf("Japanese observation expected, got: %s", a.Observation)
		}
		if a.Kind == KindProposal {
			hasProposal = true
			if !strings.Contains(a.Suggestion, "繰り返し失敗") {
				t.Errorf("Proposal should mention 繰り返し失敗, got: %s", a.Suggestion)
			}
		}
		if a.Kind == KindAlert && a.Level == LevelWarning {
			hasWarning = true
			if !strings.Contains(a.Suggestion, "根本原因") {
				t.Errorf("Warning should mention 根本原因, got: %s", a.Suggestion)
			}
		}
	}
	if !hasProposal {
		t.Error("expected proposal at 2 cycles")
	}
	if !hasWarning {
		t.Error("expected warning at 3 cycles")
	}
}

func TestExploreLoopJa(t *testing.T) {
	t.Parallel()
	d := NewDetector("ja")
	now := time.Now()
	d.Update(makeUserEvent("調べて", now))

	var alerts []Alert
	for i := range 20 {
		ts := now.Add(time.Duration(i*33) * time.Second) // spread over ~11 minutes
		toolName := "Read"
		if i%3 == 0 {
			toolName = "Grep"
		}
		result := d.Update(makeToolEvent(toolName, "/file"+itoa(i)+".go", ts))
		alerts = append(alerts, result...)
	}

	for _, a := range alerts {
		if a.Pattern == PatternExploreLoop {
			if !strings.Contains(a.Observation, "書込なし") {
				t.Errorf("Japanese observation expected, got: %s", a.Observation)
			}
			return
		}
	}
	t.Error("expected explore-loop alert in Japanese")
}

// --- Alert outcome / effect tracking tests ---

func TestAlertOutcomeResolved(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("test", now))

	// Trigger destructive cmd alert (LevelAction = 10min cooldown)
	d.Update(makeToolEvent("Bash", "rm -rf /tmp", now.Add(1*time.Second)))

	// Several events pass
	for i := range 6 {
		ts := now.Add(time.Duration(i+3) * time.Second)
		d.Update(makeToolEvent("Read", "/file"+itoa(i)+".go", ts))
	}

	// User message AFTER cooldown expires → alert no longer active → resolved
	d.Update(makeUserEvent("ok continue", now.Add(11*time.Minute)))

	outcomes := d.RecentOutcomes()
	if len(outcomes) == 0 {
		t.Fatal("expected at least one outcome after user message")
	}

	found := false
	for _, o := range outcomes {
		if o.Pattern == PatternDestructiveCmd {
			found = true
			if !o.Resolved {
				t.Error("destructive-cmd should be resolved (cooldown expired, no recurrence)")
			}
			if !strings.Contains(o.Description, "resolved") {
				t.Errorf("Description should mention resolved, got: %s", o.Description)
			}
		}
	}
	if !found {
		t.Error("expected destructive-cmd outcome")
	}
}

func TestAlertOutcomePersistedEn(t *testing.T) {
	t.Parallel()
	d := NewDetector("en")
	now := time.Now()
	d.Update(makeUserEvent("test", now))

	// Trigger retry-loop: 3 identical calls → Proposal at call 3
	for i := range 3 {
		d.Update(makeToolEvent("Bash", "ls -la", now.Add(time.Duration(i+1)*time.Second)))
	}
	// 4 more → escalation to Warning at call 5, Action at call 7 (same pattern fires again → recurrence)
	for i := range 4 {
		d.Update(makeToolEvent("Bash", "ls -la", now.Add(time.Duration(i+4)*time.Second)))
	}
	// Fill events so eventsAfter >= 5 for the Proposal-level pending
	for i := range 3 {
		d.Update(makeToolEvent("Read", "/file"+itoa(i)+".go", now.Add(time.Duration(i+8)*time.Second)))
	}

	// User message triggers checkResolutions: Proposal pending sees Warning/Action recurrence → persisted
	d.Update(makeUserEvent("continue", now.Add(12*time.Second)))

	outcomes := d.RecentOutcomes()
	found := false
	for _, o := range outcomes {
		if o.Pattern == PatternRetryLoop && !o.Resolved {
			found = true
			if !strings.Contains(o.Description, "persisted") {
				t.Errorf("Description should mention persisted, got: %s", o.Description)
			}
		}
	}
	if !found {
		t.Error("expected persisted retry-loop outcome")
	}
}

func TestAlertOutcomeResolvedJa(t *testing.T) {
	t.Parallel()
	d := NewDetector("ja")
	now := time.Now()
	d.Update(makeUserEvent("テスト", now))

	// Trigger destructive cmd alert
	d.Update(makeToolEvent("Bash", "rm -rf /tmp", now.Add(1*time.Second)))

	// Several events pass
	for i := range 6 {
		ts := now.Add(time.Duration(i+3) * time.Second)
		d.Update(makeToolEvent("Read", "/file"+itoa(i)+".go", ts))
	}

	// User message AFTER cooldown → resolved in Japanese
	d.Update(makeUserEvent("続けて", now.Add(11*time.Minute)))

	outcomes := d.RecentOutcomes()
	found := false
	for _, o := range outcomes {
		if o.Pattern == PatternDestructiveCmd && o.Resolved {
			found = true
			if !strings.Contains(o.Description, "解消しました") {
				t.Errorf("Japanese outcome should contain 解消, got: %s", o.Description)
			}
		}
	}
	if !found {
		t.Error("expected resolved destructive-cmd outcome in Japanese")
	}
}

func TestAlertOutcomePersistedJa(t *testing.T) {
	t.Parallel()
	d := NewDetector("ja")
	now := time.Now()
	d.Update(makeUserEvent("テスト", now))

	// Same escalation pattern as English test
	for i := range 3 {
		d.Update(makeToolEvent("Bash", "ls -la", now.Add(time.Duration(i+1)*time.Second)))
	}
	for i := range 4 {
		d.Update(makeToolEvent("Bash", "ls -la", now.Add(time.Duration(i+4)*time.Second)))
	}
	for i := range 3 {
		d.Update(makeToolEvent("Read", "/file"+itoa(i)+".go", now.Add(time.Duration(i+8)*time.Second)))
	}

	d.Update(makeUserEvent("続けて", now.Add(12*time.Second)))

	outcomes := d.RecentOutcomes()
	found := false
	for _, o := range outcomes {
		if o.Pattern == PatternRetryLoop && !o.Resolved {
			found = true
			if !strings.Contains(o.Description, "継続中") {
				t.Errorf("Japanese persisted should contain 継続中, got: %s", o.Description)
			}
		}
	}
	if !found {
		t.Error("expected persisted retry-loop outcome in Japanese")
	}
}
