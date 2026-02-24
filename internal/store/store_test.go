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

	// Check FTS virtual tables.
	vtables := []string{"events_fts", "decisions_fts"}
	for _, tbl := range vtables {
		var name string
		err := s.DB().QueryRow(
			"SELECT name FROM sqlite_master WHERE type='table' AND name=?", tbl,
		).Scan(&name)
		if err != nil {
			t.Errorf("virtual table %s not found: %v", tbl, err)
		}
	}
}

func TestFTSTriggers(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	s, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	// Insert a session first (foreign key).
	_, err = s.DB().Exec(`INSERT INTO sessions (id, project_path, project_name, jsonl_path) VALUES ('s1', '/tmp', 'test', '/tmp/test.jsonl')`)
	if err != nil {
		t.Fatalf("insert session: %v", err)
	}

	// Insert an event and verify FTS is populated.
	_, err = s.DB().Exec(`INSERT INTO events (session_id, event_type, timestamp, user_text) VALUES ('s1', 1, '2025-01-01T00:00:00Z', 'hello world')`)
	if err != nil {
		t.Fatalf("insert event: %v", err)
	}

	var count int
	err = s.DB().QueryRow(`SELECT count(*) FROM events_fts WHERE events_fts MATCH 'hello'`).Scan(&count)
	if err != nil {
		t.Fatalf("FTS query: %v", err)
	}
	if count != 1 {
		t.Errorf("events_fts match count = %d, want 1", count)
	}

	// Insert a decision and verify FTS.
	_, err = s.DB().Exec(`INSERT INTO decisions (session_id, timestamp, topic, decision_text) VALUES ('s1', '2025-01-01T00:00:00Z', 'architecture', 'use sqlite')`)
	if err != nil {
		t.Fatalf("insert decision: %v", err)
	}

	err = s.DB().QueryRow(`SELECT count(*) FROM decisions_fts WHERE decisions_fts MATCH 'sqlite'`).Scan(&count)
	if err != nil {
		t.Fatalf("FTS query decisions: %v", err)
	}
	if count != 1 {
		t.Errorf("decisions_fts match count = %d, want 1", count)
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
