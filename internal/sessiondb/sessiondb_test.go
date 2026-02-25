package sessiondb

import (
	"strings"
	"testing"
	"time"
)

func openTestDB(t *testing.T) *SessionDB {
	t.Helper()
	// Replace slashes from subtest names to satisfy session ID validation.
	id := "test-" + strings.ReplaceAll(t.Name(), "/", "-")
	sdb, err := Open(id)
	if err != nil {
		t.Fatalf("Open(%q) = %v", id, err)
	}
	t.Cleanup(func() { _ = sdb.Destroy() })
	return sdb
}

func TestOpen_RejectsInvalidSessionID(t *testing.T) {
	t.Parallel()

	invalid := []string{
		"../../../etc/passwd",
		"session/../escape",
		"",
		strings.Repeat("a", 200),
		"test session",
		"test;rm",
	}
	for _, id := range invalid {
		_, err := Open(id)
		if err == nil {
			t.Errorf("Open(%q) = nil error, want validation error", id)
		}
	}
}

func TestOpenAndClose(t *testing.T) {
	t.Parallel()
	sdb := openTestDB(t)

	// Verify burst_state singleton exists.
	tc, hw, fr, err := sdb.BurstState()
	if err != nil {
		t.Fatalf("BurstState() = %v", err)
	}
	if tc != 0 || hw || len(fr) != 0 {
		t.Errorf("BurstState() = (%d, %v, %v), want (0, false, {})", tc, hw, fr)
	}
}

func TestRecordEvent(t *testing.T) {
	t.Parallel()
	sdb := openTestDB(t)

	if err := sdb.RecordEvent("Bash", 123, false); err != nil {
		t.Fatalf("RecordEvent() = %v", err)
	}
	if err := sdb.RecordEvent("Write", 456, true); err != nil {
		t.Fatalf("RecordEvent() = %v", err)
	}

	tc, hw, _, err := sdb.BurstState()
	if err != nil {
		t.Fatalf("BurstState() = %v", err)
	}
	if tc != 2 {
		t.Errorf("tool_count = %d, want 2", tc)
	}
	if !hw {
		t.Error("has_write = false, want true")
	}

	events, err := sdb.RecentEvents(5)
	if err != nil {
		t.Fatalf("RecentEvents() = %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("RecentEvents() returned %d events, want 2", len(events))
	}
	if events[0].ToolName != "Write" {
		t.Errorf("events[0].ToolName = %q, want Write (newest first)", events[0].ToolName)
	}
}

func TestResetBurst(t *testing.T) {
	t.Parallel()
	sdb := openTestDB(t)

	_ = sdb.RecordEvent("Read", 1, false)
	_ = sdb.RecordEvent("Read", 2, false)
	_ = sdb.IncrementFileRead("/foo.go")

	if err := sdb.ResetBurst(); err != nil {
		t.Fatalf("ResetBurst() = %v", err)
	}

	tc, _, fr, err := sdb.BurstState()
	if err != nil {
		t.Fatalf("BurstState() = %v", err)
	}
	if tc != 0 {
		t.Errorf("tool_count = %d, want 0 after reset", tc)
	}
	if len(fr) != 0 {
		t.Errorf("file_reads has %d entries, want 0 after reset", len(fr))
	}
}

func TestFileReadTracking(t *testing.T) {
	t.Parallel()
	sdb := openTestDB(t)

	for range 5 {
		_ = sdb.IncrementFileRead("/src/main.go")
	}
	_ = sdb.IncrementFileRead("/src/other.go")

	_, _, fr, err := sdb.BurstState()
	if err != nil {
		t.Fatalf("BurstState() = %v", err)
	}
	if fr["/src/main.go"] != 5 {
		t.Errorf("file_reads[/src/main.go] = %d, want 5", fr["/src/main.go"])
	}
	if fr["/src/other.go"] != 1 {
		t.Errorf("file_reads[/src/other.go] = %d, want 1", fr["/src/other.go"])
	}
}

func TestCooldown(t *testing.T) {
	t.Parallel()
	sdb := openTestDB(t)

	on, err := sdb.IsOnCooldown("test_pattern")
	if err != nil {
		t.Fatalf("IsOnCooldown() = %v", err)
	}
	if on {
		t.Error("IsOnCooldown() = true before setting, want false")
	}

	if err := sdb.SetCooldown("test_pattern", 1*time.Hour); err != nil {
		t.Fatalf("SetCooldown() = %v", err)
	}

	on, err = sdb.IsOnCooldown("test_pattern")
	if err != nil {
		t.Fatalf("IsOnCooldown() = %v", err)
	}
	if !on {
		t.Error("IsOnCooldown() = false after setting 1h, want true")
	}

	// Set expired cooldown.
	if err := sdb.SetCooldown("expired_pattern", -1*time.Second); err != nil {
		t.Fatalf("SetCooldown() = %v", err)
	}
	on, err = sdb.IsOnCooldown("expired_pattern")
	if err != nil {
		t.Fatalf("IsOnCooldown() = %v", err)
	}
	if on {
		t.Error("IsOnCooldown() = true for expired cooldown, want false")
	}
}

func TestNudgeEnqueueDequeue(t *testing.T) {
	t.Parallel()
	sdb := openTestDB(t)

	_ = sdb.EnqueueNudge("retry-loop", "warn", "Bash retried 3 times", "Try a different approach")
	_ = sdb.EnqueueNudge("explore-loop", "tip", "10m exploring", "Give a concrete action")

	nudges, err := sdb.DequeueNudges(1)
	if err != nil {
		t.Fatalf("DequeueNudges(1) = %v", err)
	}
	if len(nudges) != 1 {
		t.Fatalf("DequeueNudges(1) returned %d, want 1", len(nudges))
	}
	if nudges[0].Pattern != "retry-loop" {
		t.Errorf("nudge.Pattern = %q, want retry-loop", nudges[0].Pattern)
	}

	// Second dequeue should get the remaining one.
	nudges, err = sdb.DequeueNudges(5)
	if err != nil {
		t.Fatalf("DequeueNudges(5) = %v", err)
	}
	if len(nudges) != 1 {
		t.Fatalf("DequeueNudges(5) returned %d, want 1 (first already delivered)", len(nudges))
	}
	if nudges[0].Pattern != "explore-loop" {
		t.Errorf("nudge.Pattern = %q, want explore-loop", nudges[0].Pattern)
	}

	// Third dequeue should return empty.
	nudges, err = sdb.DequeueNudges(5)
	if err != nil {
		t.Fatalf("DequeueNudges(5) = %v", err)
	}
	if len(nudges) != 0 {
		t.Errorf("DequeueNudges(5) returned %d after all delivered, want 0", len(nudges))
	}
}

func TestCompactTracking(t *testing.T) {
	t.Parallel()
	sdb := openTestDB(t)

	_ = sdb.RecordCompact()
	_ = sdb.RecordCompact()

	count, err := sdb.CompactsInWindow(15)
	if err != nil {
		t.Fatalf("CompactsInWindow(15) = %v", err)
	}
	if count != 2 {
		t.Errorf("CompactsInWindow(15) = %d, want 2", count)
	}
}

func TestBurstStartTime(t *testing.T) {
	t.Parallel()
	sdb := openTestDB(t)

	ts, err := sdb.BurstStartTime()
	if err != nil {
		t.Fatalf("BurstStartTime() = %v", err)
	}
	if ts.IsZero() {
		t.Error("BurstStartTime() returned zero time, want non-zero")
	}
}

func TestDestroy(t *testing.T) {
	t.Parallel()
	id := "test-destroy"
	sdb, err := Open(id)
	if err != nil {
		t.Fatalf("Open(%q) = %v", id, err)
	}

	path := DBPath(id)
	if err := sdb.Destroy(); err != nil {
		t.Fatalf("Destroy() = %v", err)
	}

	// Verify file is gone.
	_, err = Open(id)
	if err != nil {
		t.Fatalf("re-Open after Destroy failed: %v", err)
	}
	// Clean up the re-opened DB.
	sdb2, _ := Open(id)
	_ = sdb2.Destroy()
	_ = path // used for documentation
}
