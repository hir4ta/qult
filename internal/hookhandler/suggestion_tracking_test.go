package hookhandler

import (
	"strings"
	"testing"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

func openSuggTrackTestDB(t *testing.T) *sessiondb.SessionDB {
	t.Helper()
	id := "test-suggtrack-" + strings.ReplaceAll(t.Name(), "/", "-")
	sdb, err := sessiondb.Open(id)
	if err != nil {
		t.Fatalf("sessiondb.Open(%q) = %v", id, err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })
	return sdb
}

func TestCheckNudgeTimeout_LowConfidence_SkipsFeedback(t *testing.T) {
	t.Parallel()
	sdb := openSuggTrackTestDB(t)

	_ = sdb.SetContext("last_nudge_pattern", "revert-detected")
	_ = sdb.SetContext("nudge_delivered_tool_count", "0")
	_ = sdb.SetContext("last_nudge_outcome_id", "123")
	_ = sdb.SetContext("last_detection_confidence", "0.20")

	// Simulate 5 tool calls to exceed the 4-tool threshold.
	for range 5 {
		_ = sdb.RecordEvent("Read", 1, false)
	}

	checkNudgeTimeout(sdb)

	// Pattern should be cleared (timeout logic ran).
	pat, _ := sdb.GetContext("last_nudge_pattern")
	if pat != "" {
		t.Errorf("last_nudge_pattern = %q after timeout, want empty", pat)
	}

	// Confidence context should be consumed.
	conf, _ := sdb.GetContext("last_detection_confidence")
	if conf != "" {
		t.Errorf("last_detection_confidence = %q after timeout, want empty", conf)
	}
}

func TestCheckNudgeTimeout_HighConfidence_ClearsPattern(t *testing.T) {
	t.Parallel()
	sdb := openSuggTrackTestDB(t)

	_ = sdb.SetContext("last_nudge_pattern", "retry-loop")
	_ = sdb.SetContext("nudge_delivered_tool_count", "0")
	_ = sdb.SetContext("last_nudge_outcome_id", "456")
	_ = sdb.SetContext("last_detection_confidence", "0.90")

	for range 5 {
		_ = sdb.RecordEvent("Bash", 1, false)
	}

	checkNudgeTimeout(sdb)

	pat, _ := sdb.GetContext("last_nudge_pattern")
	if pat != "" {
		t.Errorf("last_nudge_pattern = %q after timeout, want empty", pat)
	}
}

func TestCheckNudgeTimeout_NoConfidence_DefaultsToFull(t *testing.T) {
	t.Parallel()
	sdb := openSuggTrackTestDB(t)

	_ = sdb.SetContext("last_nudge_pattern", "workflow")
	_ = sdb.SetContext("nudge_delivered_tool_count", "0")
	_ = sdb.SetContext("last_nudge_outcome_id", "789")
	// No last_detection_confidence set — should default to 1.0 (full feedback).

	for range 5 {
		_ = sdb.RecordEvent("Edit", 1, false)
	}

	checkNudgeTimeout(sdb)

	pat, _ := sdb.GetContext("last_nudge_pattern")
	if pat != "" {
		t.Errorf("last_nudge_pattern = %q after timeout, want empty", pat)
	}
}

func TestImplicitFeedbackThreshold(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		complexity string
		want       int
	}{
		{"low complexity", "low", 15},
		{"medium complexity", "medium", 8},
		{"high complexity", "high", 3},
		{"unknown complexity", "", 8},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			sdb := openSuggTrackTestDB(t)
			if tt.complexity != "" {
				_ = sdb.SetContext("task_complexity", tt.complexity)
			}
			got := implicitFeedbackThreshold(sdb)
			if got != tt.want {
				t.Errorf("implicitFeedbackThreshold() = %d, want %d", got, tt.want)
			}
		})
	}
}
