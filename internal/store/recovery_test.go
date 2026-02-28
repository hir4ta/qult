package store

import (
	"path/filepath"
	"testing"
)

func TestAverageRecoveryTools(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	// Insert a session for FK constraint.
	if err := s.UpsertSession(&SessionRow{
		ID: "s1", ProjectPath: "/proj/a", ProjectName: "a", JSONLPath: "/a/s1.jsonl",
	}); err != nil {
		t.Fatalf("upsert session: %v", err)
	}

	// No data: should return 0.
	if got := s.AverageRecoveryTools("bugfix"); got != 0 {
		t.Errorf("AverageRecoveryTools(no data) = %d, want 0", got)
	}

	// Only 1 successful workflow: insufficient data, should return 0.
	if err := s.InsertWorkflowSequence("s1", "bugfix", []string{"read", "write", "test"}, true, 30, 120); err != nil {
		t.Fatalf("InsertWorkflowSequence: %v", err)
	}
	if got := s.AverageRecoveryTools("bugfix"); got != 0 {
		t.Errorf("AverageRecoveryTools(1 session) = %d, want 0", got)
	}

	// Add a second successful workflow: now we have enough data.
	if err := s.InsertWorkflowSequence("s1", "bugfix", []string{"read", "write", "test"}, true, 50, 200); err != nil {
		t.Fatalf("InsertWorkflowSequence: %v", err)
	}
	// Average of 30 and 50 = 40.
	if got := s.AverageRecoveryTools("bugfix"); got != 40 {
		t.Errorf("AverageRecoveryTools(2 sessions) = %d, want 40", got)
	}

	// Failed workflows should not be counted.
	if err := s.InsertWorkflowSequence("s1", "bugfix", []string{"read", "write"}, false, 100, 300); err != nil {
		t.Fatalf("InsertWorkflowSequence: %v", err)
	}
	// Still 40 (only successful ones).
	if got := s.AverageRecoveryTools("bugfix"); got != 40 {
		t.Errorf("AverageRecoveryTools(with failed) = %d, want 40", got)
	}

	// Different task type should return 0.
	if got := s.AverageRecoveryTools("feature"); got != 0 {
		t.Errorf("AverageRecoveryTools(different task type) = %d, want 0", got)
	}

	// Add a third successful workflow with tool_count=0 (should be excluded).
	if err := s.InsertWorkflowSequence("s1", "bugfix", []string{"read"}, true, 0, 10); err != nil {
		t.Fatalf("InsertWorkflowSequence: %v", err)
	}
	// Still 40 (tool_count=0 excluded).
	if got := s.AverageRecoveryTools("bugfix"); got != 40 {
		t.Errorf("AverageRecoveryTools(with zero tool_count) = %d, want 40", got)
	}
}
