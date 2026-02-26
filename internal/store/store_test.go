package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenClose(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	s, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	if s.DB() == nil {
		t.Fatal("DB() returned nil")
	}

	if err := s.DB().Ping(); err != nil {
		t.Fatalf("Ping: %v", err)
	}
}

func TestOpenCreatesDirectory(t *testing.T) {
	dir := t.TempDir()
	nested := filepath.Join(dir, "a", "b", "c")
	dbPath := filepath.Join(nested, "test.db")

	s, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	if _, err := os.Stat(nested); err != nil {
		t.Fatalf("directory not created: %v", err)
	}
}

func TestMigrateIdempotent(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	s, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open (first): %v", err)
	}
	s.Close()

	// Open again — Migrate runs a second time.
	s2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open (second): %v", err)
	}
	defer s2.Close()

	var ver int
	if err := s2.DB().QueryRow("SELECT version FROM schema_version").Scan(&ver); err != nil {
		t.Fatalf("query schema_version: %v", err)
	}
	if ver != schemaVersion {
		t.Fatalf("schema_version = %d, want %d", ver, schemaVersion)
	}
}

func TestTablesExist(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	s, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	tables := []string{"sessions", "events", "compact_events", "decisions", "schema_version"}
	for _, tbl := range tables {
		var name string
		err := s.DB().QueryRow(
			"SELECT name FROM sqlite_master WHERE type='table' AND name=?", tbl,
		).Scan(&name)
		if err != nil {
			t.Errorf("table %s not found: %v", tbl, err)
		}
	}
}

func TestGetAlertPatternFrequency(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	// Insert session
	if err := s.UpsertSession(&SessionRow{
		ID: "s1", ProjectPath: "/proj/a", ProjectName: "a", JSONLPath: "/a/s1.jsonl",
	}); err != nil {
		t.Fatalf("upsert session: %v", err)
	}

	// Insert an event to satisfy FK constraints
	evID, err := s.InsertEvent(&EventRow{
		SessionID: "s1", EventType: 0, Timestamp: "2025-01-01T00:00:00Z", UserText: "test",
	})
	if err != nil {
		t.Fatalf("InsertEvent: %v", err)
	}

	// Insert alerts
	for i := 0; i < 5; i++ {
		if _, err := s.InsertAlert("s1", AlertRow{PatternType: "retry-loop", Level: "warning", Timestamp: "2025-01-01T00:00:00Z", FirstEventID: evID, LastEventID: evID}); err != nil {
			t.Fatalf("InsertAlert retry-loop: %v", err)
		}
	}
	for i := 0; i < 2; i++ {
		if _, err := s.InsertAlert("s1", AlertRow{PatternType: "context-thrashing", Level: "action", Timestamp: "2025-01-02T00:00:00Z", FirstEventID: evID, LastEventID: evID}); err != nil {
			t.Fatalf("InsertAlert context-thrashing: %v", err)
		}
	}

	freqs, err := s.GetAlertPatternFrequency("/proj/a")
	if err != nil {
		t.Fatalf("GetAlertPatternFrequency: %v", err)
	}
	if len(freqs) != 2 {
		t.Fatalf("got %d pattern frequencies, want 2", len(freqs))
	}
	// Should be sorted by count DESC
	if freqs[0].PatternType != "retry-loop" || freqs[0].Count != 5 {
		t.Errorf("freqs[0] = %+v, want retry-loop:5", freqs[0])
	}
	if freqs[1].PatternType != "context-thrashing" || freqs[1].Count != 2 {
		t.Errorf("freqs[1] = %+v, want context-thrashing:2", freqs[1])
	}
}

func TestGetProjectSessionStats(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	s.UpsertSession(&SessionRow{
		ID: "s1", ProjectPath: "/proj/a", ProjectName: "a", JSONLPath: "/a/s1.jsonl",
		TurnCount: 10, ToolUseCount: 30, CompactCount: 1,
	})
	s.UpsertSession(&SessionRow{
		ID: "s2", ProjectPath: "/proj/a", ProjectName: "a", JSONLPath: "/a/s2.jsonl",
		TurnCount: 20, ToolUseCount: 50, CompactCount: 3,
	})

	ps, err := s.GetProjectSessionStats("/proj/a")
	if err != nil {
		t.Fatalf("GetProjectSessionStats: %v", err)
	}
	if ps.TotalSessions != 2 {
		t.Errorf("TotalSessions = %d, want 2", ps.TotalSessions)
	}
	if ps.TotalTurns != 30 {
		t.Errorf("TotalTurns = %d, want 30", ps.TotalTurns)
	}
	if ps.TotalCompacts != 4 {
		t.Errorf("TotalCompacts = %d, want 4", ps.TotalCompacts)
	}
	if ps.AvgCompactsPerSess != 2.0 {
		t.Errorf("AvgCompactsPerSess = %f, want 2.0", ps.AvgCompactsPerSess)
	}
}

func TestGetFileReworkHotspots(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	for _, id := range []string{"s1", "s2", "s3"} {
		s.UpsertSession(&SessionRow{
			ID: id, ProjectPath: "/proj/a", ProjectName: "a", JSONLPath: "/a/" + id + ".jsonl",
		})
		s.InsertEvent(&EventRow{
			SessionID: id, EventType: 2, Timestamp: "2025-01-01T00:00:00Z",
			ToolName: "Edit", ToolInput: "/proj/a/hot.go",
		})
	}
	// This file only in one session
	s.InsertEvent(&EventRow{
		SessionID: "s1", EventType: 2, Timestamp: "2025-01-01T00:00:00Z",
		ToolName: "Edit", ToolInput: "/proj/a/cold.go",
	})

	hotspots, err := s.GetFileReworkHotspots("/proj/a", 3)
	if err != nil {
		t.Fatalf("GetFileReworkHotspots: %v", err)
	}
	if len(hotspots) != 1 {
		t.Fatalf("got %d hotspots, want 1", len(hotspots))
	}
	if hotspots[0].Path != "/proj/a/hot.go" || hotspots[0].SessionCount != 3 {
		t.Errorf("hotspot = %+v, want hot.go:3", hotspots[0])
	}
}

func TestSuggestionOutcome_CRUD(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	id, err := s.InsertSuggestionOutcome("sess-1", "code-quality", "debug print detected")
	if err != nil {
		t.Fatalf("InsertSuggestionOutcome() = %v", err)
	}
	if id == 0 {
		t.Fatal("InsertSuggestionOutcome() returned id=0")
	}

	// Initially unresolved.
	delivered, resolved, err := s.PatternEffectiveness("code-quality")
	if err != nil {
		t.Fatalf("PatternEffectiveness() = %v", err)
	}
	if delivered != 1 || resolved != 0 {
		t.Errorf("PatternEffectiveness() = (%d, %d), want (1, 0)", delivered, resolved)
	}

	// Resolve it.
	if err := s.ResolveSuggestion(id); err != nil {
		t.Fatalf("ResolveSuggestion() = %v", err)
	}

	delivered, resolved, err = s.PatternEffectiveness("code-quality")
	if err != nil {
		t.Fatalf("PatternEffectiveness() after resolve = %v", err)
	}
	if delivered != 1 || resolved != 1 {
		t.Errorf("PatternEffectiveness() = (%d, %d), want (1, 1)", delivered, resolved)
	}

	// Double resolve is a no-op.
	if err := s.ResolveSuggestion(id); err != nil {
		t.Fatalf("ResolveSuggestion() double = %v", err)
	}
}

func TestResolveLastSuggestion(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	s.InsertSuggestionOutcome("sess-1", "workflow", "nudge 1")
	s.InsertSuggestionOutcome("sess-1", "workflow", "nudge 2")

	if err := s.ResolveLastSuggestion("sess-1", "workflow"); err != nil {
		t.Fatalf("ResolveLastSuggestion() = %v", err)
	}

	delivered, resolved, _ := s.PatternEffectiveness("workflow")
	if delivered != 2 || resolved != 1 {
		t.Errorf("PatternEffectiveness() = (%d, %d), want (2, 1)", delivered, resolved)
	}
}

func TestShouldSuppressPattern(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	// Below decayed threshold (~15): should not suppress.
	for i := 0; i < 14; i++ {
		s.InsertSuggestionOutcome("sess-1", "noisy", "msg")
	}
	if s.ShouldSuppressPattern("noisy") {
		t.Error("ShouldSuppressPattern(14 delivered) = true, want false")
	}

	// Above threshold with 0% resolution: should suppress.
	for i := 0; i < 6; i++ {
		s.InsertSuggestionOutcome("sess-1", "noisy", "msg")
	}
	if !s.ShouldSuppressPattern("noisy") {
		t.Error("ShouldSuppressPattern(20 delivered, 0 resolved) = false, want true")
	}

	// Good pattern (50% resolved) should not suppress.
	for i := 0; i < 20; i++ {
		id, _ := s.InsertSuggestionOutcome("sess-1", "useful", "msg")
		if i%2 == 0 {
			s.ResolveSuggestion(id)
		}
	}
	if s.ShouldSuppressPattern("useful") {
		t.Error("ShouldSuppressPattern(50% resolved) = true, want false")
	}
}

func TestDecayedPatternEffectiveness(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	// No data should return zeros.
	d, r, err := s.DecayedPatternEffectiveness("empty")
	if err != nil {
		t.Fatalf("DecayedPatternEffectiveness: %v", err)
	}
	if d != 0 || r != 0 {
		t.Errorf("empty pattern: delivered=%v, resolved=%v, want 0, 0", d, r)
	}

	// Recent outcomes should contribute ~1.0 each.
	for i := 0; i < 10; i++ {
		id, _ := s.InsertSuggestionOutcome("sess-1", "recent", "msg")
		if i < 3 {
			s.ResolveSuggestion(id)
		}
	}
	d, r, err = s.DecayedPatternEffectiveness("recent")
	if err != nil {
		t.Fatalf("DecayedPatternEffectiveness: %v", err)
	}
	// Recent records should have weight close to 1.0 each.
	if d < 9.5 || d > 10.5 {
		t.Errorf("recent delivered=%v, want ~10", d)
	}
	if r < 2.5 || r > 3.5 {
		t.Errorf("recent resolved=%v, want ~3", r)
	}
}

func TestDefaultDBPath(t *testing.T) {
	p := DefaultDBPath()
	if filepath.Base(p) != "buddy.db" {
		t.Errorf("DefaultDBPath() = %s, want */buddy.db", p)
	}
	if filepath.Base(filepath.Dir(p)) != ".claude-buddy" {
		t.Errorf("DefaultDBPath() parent = %s, want .claude-buddy", filepath.Dir(p))
	}
}
