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

func TestDefaultDBPath(t *testing.T) {
	p := DefaultDBPath()
	if filepath.Base(p) != "alfred.db" {
		t.Errorf("DefaultDBPath() = %s, want */alfred.db", p)
	}
	if filepath.Base(filepath.Dir(p)) != ".claude-alfred" {
		t.Errorf("DefaultDBPath() parent = %s, want .claude-alfred", filepath.Dir(p))
	}
}
