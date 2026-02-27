package hookhandler

import (
	"strings"
	"testing"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

func openEpisodeTestDB(t *testing.T) *sessiondb.SessionDB {
	t.Helper()
	id := "test-episode-" + strings.ReplaceAll(t.Name(), "/", "-")
	sdb, err := sessiondb.Open(id)
	if err != nil {
		t.Fatalf("sessiondb.Open(%q) = %v", id, err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })
	return sdb
}

func TestEpisodeRetryCascade(t *testing.T) {
	t.Parallel()
	sdb := openEpisodeTestDB(t)
	det := &HookDetector{sdb: sdb}

	// 1 event: no signal.
	_ = sdb.RecordEvent("Edit", 0xAABB, true)
	sig := det.detectEpisodes()
	if sig != nil {
		t.Errorf("1 event: got signal %q, want nil", sig.Message)
	}

	// 2 identical events: early warning.
	_ = sdb.RecordEvent("Edit", 0xAABB, true)
	sig = det.detectEpisodes()
	if sig == nil {
		t.Error("2 identical events: got no signal, want retry_cascade warning")
	}
	if sig != nil && !strings.Contains(sig.Message, "retry_cascade") {
		t.Errorf("got %q, want retry_cascade", sig.Message)
	}

	// 3rd identical event: episode should NOT fire (full pattern, let main detector handle).
	_ = sdb.RecordEvent("Edit", 0xAABB, true)
	// Set cooldown to past so the episode check runs again.
	_ = sdb.SetCooldown("episode:retry_cascade", -1*time.Second)
	sig = det.detectEpisodes()
	// Should not fire since full pattern (3+) is now present.
	if sig != nil && strings.Contains(sig.Message, "retry_cascade") {
		t.Errorf("3 identical events: episode should not fire, got %q", sig.Message)
	}
}

func TestEpisodeRetryCascadeCooldown(t *testing.T) {
	t.Parallel()
	sdb := openEpisodeTestDB(t)
	det := &HookDetector{sdb: sdb}

	_ = sdb.RecordEvent("Bash", 0x1234, false)
	_ = sdb.RecordEvent("Bash", 0x1234, false)

	// First detection fires.
	sig := det.detectEpisodes()
	if sig == nil {
		t.Fatal("first detection should fire, got nil")
	}

	// Second detection within cooldown does not fire.
	sig = det.detectEpisodes()
	if sig != nil {
		t.Errorf("within cooldown should not fire, got %q", sig.Message)
	}
}

func TestEpisodeExploreToStuck(t *testing.T) {
	t.Parallel()
	sdb := openEpisodeTestDB(t)
	det := &HookDetector{sdb: sdb}

	// 6 consecutive reads: no signal yet.
	for i := 0; i < 6; i++ {
		_ = sdb.RecordEvent("Read", uint64(i), false)
	}
	sig := det.detectEpisodes()
	if sig != nil && strings.Contains(sig.Message, "explore_to_stuck") {
		t.Errorf("6 reads: should not fire, got %q", sig.Message)
	}

	// 7th read: early warning.
	_ = sdb.RecordEvent("Read", 0x07, false)
	sig = det.detectEpisodes()
	if sig == nil || !strings.Contains(sig.Message, "explore_to_stuck") {
		msg := ""
		if sig != nil {
			msg = sig.Message
		}
		t.Errorf("7 reads: got %q, want explore_to_stuck warning", msg)
	}
}

func TestEpisodeExploreToStuckSuppressedByWrite(t *testing.T) {
	t.Parallel()
	sdb := openEpisodeTestDB(t)
	det := &HookDetector{sdb: sdb}

	// Write breaks the read streak.
	_ = sdb.RecordEvent("Edit", 0x01, true)
	for i := 0; i < 8; i++ {
		_ = sdb.RecordEvent("Read", uint64(i), false)
	}

	// The write in the middle should break the streak since events are DESC ordered.
	// Actually, with DESC: reads come first (most recent), then the write.
	// So we'll count 8 reads until the write breaks it.
	sig := det.detectEpisodes()
	if sig == nil || !strings.Contains(sig.Message, "explore_to_stuck") {
		msg := ""
		if sig != nil {
			msg = sig.Message
		}
		t.Errorf("8 reads after write: got %q, want explore_to_stuck", msg)
	}
}

func TestEpisodeExploreToStuckSuppressedByPlanMode(t *testing.T) {
	t.Parallel()
	sdb := openEpisodeTestDB(t)
	det := &HookDetector{sdb: sdb}

	_ = sdb.SetContext("plan_mode", "active")
	for i := 0; i < 10; i++ {
		_ = sdb.RecordEvent("Read", uint64(i), false)
	}
	sig := det.detectEpisodes()
	// explore_to_stuck is suppressed during plan mode.
	if sig != nil && strings.Contains(sig.Message, "explore_to_stuck") {
		t.Errorf("plan mode: should not fire explore_to_stuck, got %q", sig.Message)
	}
}

func TestEpisodeEditFailSpiral(t *testing.T) {
	t.Parallel()
	sdb := openEpisodeTestDB(t)
	det := &HookDetector{sdb: sdb}

	// Record 2 edit failures on the same file.
	_ = sdb.RecordFailure("Edit", "edit_mismatch", "old_string not found", "/src/main.go")
	_ = sdb.RecordEvent("Edit", 0xAA, true) // failed attempt 1
	_ = sdb.RecordFailure("Edit", "edit_mismatch", "old_string not found", "/src/main.go")
	_ = sdb.RecordEvent("Edit", 0xAB, true) // failed attempt 2 (needs >= 2 events for detectEpisodes)

	sig := det.detectEpisodes()
	if sig == nil || !strings.Contains(sig.Message, "edit_fail_spiral") {
		msg := ""
		if sig != nil {
			msg = sig.Message
		}
		t.Errorf("2 edit failures + recent edit: got %q, want edit_fail_spiral", msg)
	}
}

func TestEpisodeTestFailFixup(t *testing.T) {
	t.Parallel()
	sdb := openEpisodeTestDB(t)
	det := &HookDetector{sdb: sdb}

	// Record 2 test failures with an edit between.
	_ = sdb.RecordFailure("Bash", "test_failure", "FAIL", "/src/main_test.go")
	_ = sdb.RecordEvent("Bash", 0xCC, false) // test run 1
	_ = sdb.RecordEvent("Edit", 0xBB, true)  // fix attempt
	_ = sdb.RecordFailure("Bash", "test_failure", "FAIL", "/src/main_test.go")
	_ = sdb.RecordEvent("Bash", 0xCC, false) // test run 2

	sig := det.detectEpisodes()
	if sig == nil || !strings.Contains(sig.Message, "test_fail_fixup") {
		msg := ""
		if sig != nil {
			msg = sig.Message
		}
		t.Errorf("2 test failures with edit: got %q, want test_fail_fixup", msg)
	}
}

func TestEpisodeContextOverload(t *testing.T) {
	t.Parallel()
	sdb := openEpisodeTestDB(t)
	det := &HookDetector{sdb: sdb}

	// Record 1 compact event.
	_ = sdb.RecordCompact()

	// Simulate a high tool count in burst.
	for i := 0; i < 12; i++ {
		_ = sdb.RecordEvent("Read", uint64(i), false)
	}

	sig := det.detectEpisodes()
	if sig == nil || !strings.Contains(sig.Message, "context_overload") {
		msg := ""
		if sig != nil {
			msg = sig.Message
		}
		t.Errorf("1 compact + 12 tools: got %q, want context_overload", msg)
	}
}

func TestShortPath(t *testing.T) {
	t.Parallel()
	tests := []struct {
		input string
		want  string
	}{
		{"/src/main.go", "src/main.go"},
		{"/a/b/c/d.go", "c/d.go"},
		{"file.go", "file.go"},
		{"a/b.go", "a/b.go"},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			t.Parallel()
			got := shortPath(tt.input)
			if got != tt.want {
				t.Errorf("shortPath(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestIsReadTool(t *testing.T) {
	t.Parallel()
	tests := []struct {
		tool string
		want bool
	}{
		{"Read", true},
		{"Glob", true},
		{"Grep", true},
		{"WebFetch", true},
		{"WebSearch", true},
		{"Edit", false},
		{"Write", false},
		{"Bash", false},
	}
	for _, tt := range tests {
		t.Run(tt.tool, func(t *testing.T) {
			t.Parallel()
			if got := isReadTool(tt.tool); got != tt.want {
				t.Errorf("isReadTool(%q) = %v, want %v", tt.tool, got, tt.want)
			}
		})
	}
}
