package hookhandler

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
	"github.com/hir4ta/claude-buddy/internal/store"
)

func setupTestStore(t *testing.T) (*store.Store, string) {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	return st, dbPath
}

// setupDefaultTestStore creates a test store at the DefaultDBPath location
// by overriding $HOME. Functions that call store.OpenDefault() will use this.
func setupDefaultTestStore(t *testing.T) *store.Store {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	st, err := store.OpenDefault()
	if err != nil {
		t.Fatalf("open default store: %v", err)
	}
	return st
}

func setupTestSessionDB(t *testing.T) *sessiondb.SessionDB {
	t.Helper()
	sid := "test-strategic-" + t.Name()
	sdb, err := sessiondb.Open(sid)
	if err != nil {
		t.Fatalf("open sessiondb: %v", err)
	}
	t.Cleanup(func() {
		sdb.Close()
		// Clean up the temp db file.
		dbPath := filepath.Join(os.TempDir(), "claude-buddy", "session-"+sid+".db")
		os.Remove(dbPath)
	})
	return sdb
}

func TestBehavioralTrend_LowTestFrequency(t *testing.T) {
	st, dbPath := setupTestStore(t)
	defer st.Close()
	defer os.Remove(dbPath)

	// Seed low test frequency.
	for i := 0; i < 6; i++ {
		_ = st.UpdateUserProfile("test_frequency", 0.2)
	}

	insight := behavioralTrend(st)
	if insight == nil {
		t.Fatal("expected insight for low test frequency, got nil")
	}
	if insight.category != "trend" {
		t.Errorf("category = %q, want %q", insight.category, "trend")
	}
	if insight.priority != 1 {
		t.Errorf("priority = %d, want 1", insight.priority)
	}
}

func TestBehavioralTrend_HighReadWriteRatio(t *testing.T) {
	st, dbPath := setupTestStore(t)
	defer st.Close()
	defer os.Remove(dbPath)

	// Seed high read/write ratio (over-reading).
	for i := 0; i < 6; i++ {
		_ = st.UpdateUserProfile("read_write_ratio", 5.0)
	}

	insight := behavioralTrend(st)
	if insight == nil {
		t.Fatal("expected insight for high read/write ratio, got nil")
	}
	if insight.category != "trend" {
		t.Errorf("category = %q, want %q", insight.category, "trend")
	}
}

func TestBehavioralTrend_BalancedMetrics(t *testing.T) {
	st, dbPath := setupTestStore(t)
	defer st.Close()
	defer os.Remove(dbPath)

	// Balanced metrics — no insight should fire.
	for i := 0; i < 6; i++ {
		_ = st.UpdateUserProfile("test_frequency", 0.5)
		_ = st.UpdateUserProfile("read_write_ratio", 2.0)
		_ = st.UpdateUserProfile("compact_frequency", 0.2)
	}

	insight := behavioralTrend(st)
	if insight != nil {
		t.Errorf("expected nil for balanced metrics, got %+v", insight)
	}
}

func TestMomentumInsight_Nil_WhenNoData(t *testing.T) {
	sdb := setupTestSessionDB(t)

	insight := momentumInsight(sdb)
	if insight != nil {
		t.Errorf("expected nil with no health data, got %+v", insight)
	}
}

func TestRecurringStruggle_Nil_WhenNoProject(t *testing.T) {
	st, dbPath := setupTestStore(t)
	defer st.Close()
	defer os.Remove(dbPath)

	insight := recurringStruggle(st, "")
	if insight != nil {
		t.Errorf("expected nil for empty project path, got %+v", insight)
	}
}

func TestSessionPaceInsight_Nil_WhenUnknownTask(t *testing.T) {
	sdb := setupTestSessionDB(t)
	st, dbPath := setupTestStore(t)
	defer st.Close()
	defer os.Remove(dbPath)

	insight := sessionPaceInsight(sdb, st, TaskUnknown, "/test")
	if insight != nil {
		t.Errorf("expected nil for unknown task type, got %+v", insight)
	}
}

func TestTrajectoryWarning_Nil_WhenFewPhases(t *testing.T) {
	sdb := setupTestSessionDB(t)
	st, dbPath := setupTestStore(t)
	defer st.Close()
	defer os.Remove(dbPath)

	// Too few phases — should return nil.
	insight := trajectoryWarning(sdb, st, TaskBugfix)
	if insight != nil {
		t.Errorf("expected nil with few phases, got %+v", insight)
	}
}

func TestInferDomainFromFiles(t *testing.T) {
	sdb := setupTestSessionDB(t)

	// Add auth-related files.
	_ = sdb.AddWorkingSetFile("/project/internal/auth/handler.go")
	_ = sdb.AddWorkingSetFile("/project/internal/auth/token.go")

	domain := inferDomainFromFiles(sdb)
	if domain != "auth" {
		t.Errorf("domain = %q, want %q", domain, "auth")
	}
}

func TestInferDomainFromFiles_General(t *testing.T) {
	sdb := setupTestSessionDB(t)

	// No domain-specific files.
	_ = sdb.AddWorkingSetFile("/project/main.go")
	_ = sdb.AddWorkingSetFile("/project/utils.go")

	domain := inferDomainFromFiles(sdb)
	if domain != "general" {
		t.Errorf("domain = %q, want %q", domain, "general")
	}
}

func TestPersonalizeCoaching_EnrichesWithHistory(t *testing.T) {
	sdb := setupTestSessionDB(t)
	// Use default store override so personalizeCoaching's store.OpenDefault() finds our data.
	st := setupDefaultTestStore(t)
	defer st.Close()

	for i := range 5 {
		sid := "session-" + string(rune('a'+i))
		_ = st.UpsertSession(&store.SessionRow{
			ID:           sid,
			ProjectPath:  "",
			TurnCount:    10,
			ToolUseCount: 20 + i,
		})
		_ = st.InsertWorkflowSequence(
			sid, "bugfix",
			[]string{"read", "write", "test"}, true, 20+i, 300,
		)
	}

	entry := coachingEntry{
		situation:  "Testing the bug fix",
		reasoning:  "A fix without a regression test will likely break again.",
		suggestion: "Add a regression test.",
	}

	result := personalizeCoaching(sdb, entry, TaskBugfix)

	// Should have personal note appended to reasoning.
	if result.reasoning == entry.reasoning {
		t.Error("expected reasoning to be enriched with personal data")
	}
	if result.situation != entry.situation {
		t.Error("situation should not change")
	}
}

func TestTrackImplicitFeedback_NoOpBelow10Turns(t *testing.T) {
	sdb := setupTestSessionDB(t)

	// Simulate 5 turns — should not record feedback.
	for i := 0; i < 5; i++ {
		trackImplicitFeedback(sdb, "test-session")
	}

	val, _ := sdb.GetContext("turns_since_buddy_call")
	if val != "5" {
		t.Errorf("turns_since_buddy_call = %q, want %q", val, "5")
	}
}

func TestResetBuddyCallTracker(t *testing.T) {
	sdb := setupTestSessionDB(t)

	_ = sdb.SetContext("turns_since_buddy_call", "15")
	ResetBuddyCallTracker(sdb)

	val, _ := sdb.GetContext("turns_since_buddy_call")
	if val != "0" {
		t.Errorf("turns_since_buddy_call = %q after reset, want %q", val, "0")
	}
}
