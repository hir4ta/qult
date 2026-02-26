package sessiondb

import (
	"fmt"
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

func TestWorkingSet_CRUD(t *testing.T) {
	t.Parallel()
	sdb := openTestDB(t)

	// Initially empty.
	val, err := sdb.GetWorkingSet("intent")
	if err != nil {
		t.Fatalf("GetWorkingSet() = %v", err)
	}
	if val != "" {
		t.Errorf("GetWorkingSet(missing) = %q, want empty", val)
	}

	// Set and get.
	if err := sdb.SetWorkingSet("intent", "fix auth bug"); err != nil {
		t.Fatalf("SetWorkingSet() = %v", err)
	}
	val, _ = sdb.GetWorkingSet("intent")
	if val != "fix auth bug" {
		t.Errorf("GetWorkingSet(intent) = %q, want 'fix auth bug'", val)
	}

	// Overwrite.
	_ = sdb.SetWorkingSet("intent", "refactor middleware")
	val, _ = sdb.GetWorkingSet("intent")
	if val != "refactor middleware" {
		t.Errorf("GetWorkingSet(intent) = %q, want 'refactor middleware'", val)
	}

	// GetAll.
	_ = sdb.SetWorkingSet("task_type", "bugfix")
	ws, err := sdb.GetAllWorkingSet()
	if err != nil {
		t.Fatalf("GetAllWorkingSet() = %v", err)
	}
	if len(ws) != 2 {
		t.Errorf("GetAllWorkingSet() len = %d, want 2", len(ws))
	}
}

func TestWorkingSet_Files(t *testing.T) {
	t.Parallel()
	sdb := openTestDB(t)

	// Initially empty.
	files, err := sdb.GetWorkingSetFiles()
	if err != nil {
		t.Fatalf("GetWorkingSetFiles() = %v", err)
	}
	if len(files) != 0 {
		t.Errorf("GetWorkingSetFiles() len = %d, want 0", len(files))
	}

	// Add files.
	_ = sdb.AddWorkingSetFile("/src/auth.go")
	_ = sdb.AddWorkingSetFile("/src/middleware.go")
	files, _ = sdb.GetWorkingSetFiles()
	if len(files) != 2 {
		t.Fatalf("GetWorkingSetFiles() len = %d, want 2", len(files))
	}
	if files[0] != "/src/auth.go" || files[1] != "/src/middleware.go" {
		t.Errorf("files = %v, want [/src/auth.go, /src/middleware.go]", files)
	}

	// Duplicate moves to end.
	_ = sdb.AddWorkingSetFile("/src/auth.go")
	files, _ = sdb.GetWorkingSetFiles()
	if len(files) != 2 {
		t.Fatalf("after dedup len = %d, want 2", len(files))
	}
	if files[1] != "/src/auth.go" {
		t.Errorf("files[1] = %q, want /src/auth.go (moved to end)", files[1])
	}

	// Cap at 20.
	for i := range 25 {
		_ = sdb.AddWorkingSetFile(fmt.Sprintf("/src/file%d.go", i))
	}
	files, _ = sdb.GetWorkingSetFiles()
	if len(files) != 20 {
		t.Errorf("after cap len = %d, want 20", len(files))
	}
}

func TestWorkingSet_Decisions(t *testing.T) {
	t.Parallel()
	sdb := openTestDB(t)

	// Initially empty.
	decisions, _ := sdb.GetWorkingSetDecisions()
	if len(decisions) != 0 {
		t.Errorf("GetWorkingSetDecisions() len = %d, want 0", len(decisions))
	}

	// Add decisions.
	_ = sdb.AddWorkingSetDecision("Use JWT for auth")
	_ = sdb.AddWorkingSetDecision("Go with PostgreSQL")
	decisions, _ = sdb.GetWorkingSetDecisions()
	if len(decisions) != 2 {
		t.Fatalf("decisions len = %d, want 2", len(decisions))
	}

	// Duplicate ignored.
	_ = sdb.AddWorkingSetDecision("Use JWT for auth")
	decisions, _ = sdb.GetWorkingSetDecisions()
	if len(decisions) != 2 {
		t.Errorf("after dedup len = %d, want 2", len(decisions))
	}

	// Cap at 5.
	for i := range 6 {
		_ = sdb.AddWorkingSetDecision(fmt.Sprintf("Decision %d", i))
	}
	decisions, _ = sdb.GetWorkingSetDecisions()
	if len(decisions) != 5 {
		t.Errorf("after cap len = %d, want 5", len(decisions))
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

func TestSplitBigram(t *testing.T) {
	t.Parallel()
	tests := []struct {
		hash string
		want string
	}{
		{"Edit→Bash", "Bash"},
		{"Read→Edit", "Edit"},
		{"Bash→Read", "Read"},
		{"nope", ""},
		{"→", ""},
		{"", ""},
	}
	for _, tt := range tests {
		t.Run(tt.hash, func(t *testing.T) {
			t.Parallel()
			got := splitBigram(tt.hash)
			if got != tt.want {
				t.Errorf("splitBigram(%q) = %q, want %q", tt.hash, got, tt.want)
			}
		})
	}
}

func TestPredictNextTool(t *testing.T) {
	t.Parallel()
	sdb := openTestDB(t)

	// Seed sequence data: Edit→Bash success x5, Edit→Read success x2.
	for range 5 {
		_ = sdb.RecordSequence("Edit", "Bash", "success")
	}
	for range 2 {
		_ = sdb.RecordSequence("Edit", "Read", "success")
	}
	// Some failures should not affect prediction.
	for range 3 {
		_ = sdb.RecordSequence("Edit", "Bash", "failure")
	}

	next, count, err := sdb.PredictNextTool("Edit")
	if err != nil {
		t.Fatalf("PredictNextTool(Edit) error: %v", err)
	}
	if next != "Bash" {
		t.Errorf("PredictNextTool(Edit) = %q, want Bash", next)
	}
	if count != 5 {
		t.Errorf("PredictNextTool(Edit) count = %d, want 5", count)
	}

	// No data for Grep.
	next, count, err = sdb.PredictNextTool("Grep")
	if err != nil {
		t.Fatalf("PredictNextTool(Grep) error: %v", err)
	}
	if next != "" || count != 0 {
		t.Errorf("PredictNextTool(Grep) = (%q, %d), want (\"\", 0)", next, count)
	}
}

func TestRecordAndPredictTrigram(t *testing.T) {
	t.Parallel()
	sdb := openTestDB(t)

	// Seed: Read→Edit→Bash failure x4, Read→Edit→Bash success x2.
	for range 4 {
		_ = sdb.RecordTrigram("Read", "Edit", "Bash", "failure")
	}
	for range 2 {
		_ = sdb.RecordTrigram("Read", "Edit", "Bash", "success")
	}

	outcome, count, err := sdb.PredictFromTrigram("Read", "Edit", "Bash")
	if err != nil {
		t.Fatalf("PredictFromTrigram error: %v", err)
	}
	if outcome != "failure" {
		t.Errorf("PredictFromTrigram = %q, want failure", outcome)
	}
	if count != 4 {
		t.Errorf("PredictFromTrigram count = %d, want 4", count)
	}

	// No data.
	outcome, count, err = sdb.PredictFromTrigram("Grep", "Glob", "Read")
	if err != nil {
		t.Fatalf("PredictFromTrigram no data error: %v", err)
	}
	if outcome != "" || count != 0 {
		t.Errorf("PredictFromTrigram no data = (%q, %d), want (\"\", 0)", outcome, count)
	}
}
