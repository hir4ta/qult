package store

import (
	"path/filepath"
	"testing"
)

func TestInsertAndSearchDecisions(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	s, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	// Insert a session first (foreign key).
	_, err = s.DB().Exec(`INSERT INTO sessions (id, project_path, project_name, jsonl_path) VALUES ('s1', '/tmp', 'test-project', '/tmp/test.jsonl')`)
	if err != nil {
		t.Fatalf("insert session: %v", err)
	}

	d := &DecisionRow{
		SessionID:    "s1",
		Timestamp:    "2025-01-01T00:00:00Z",
		Topic:        "database choice",
		DecisionText: "decided to use SQLite for local storage",
		Reasoning:    "SQLite is lightweight and embedded, perfect for local-first apps",
		FilePaths:    `["internal/store/store.go"]`,
	}
	if err := s.InsertDecision(d); err != nil {
		t.Fatalf("InsertDecision: %v", err)
	}
	if d.ID == 0 {
		t.Error("expected non-zero ID after insert")
	}

	// Search by LIKE.
	results, err := s.SearchDecisions("sqlite", "", 10)
	if err != nil {
		t.Fatalf("SearchDecisions: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 search result, got %d", len(results))
	}
	if results[0].DecisionText != d.DecisionText {
		t.Errorf("decision_text = %q, want %q", results[0].DecisionText, d.DecisionText)
	}

	// Search with session filter.
	results, err = s.SearchDecisions("sqlite", "s1", 10)
	if err != nil {
		t.Fatalf("SearchDecisions with session: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result with session filter, got %d", len(results))
	}

	// Search with wrong session.
	results, err = s.SearchDecisions("sqlite", "nonexistent", 10)
	if err != nil {
		t.Fatalf("SearchDecisions with wrong session: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results with wrong session, got %d", len(results))
	}
}

func TestGetDecisions(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	s, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	// Insert sessions.
	_, err = s.DB().Exec(`INSERT INTO sessions (id, project_path, project_name, jsonl_path) VALUES ('s1', '/tmp/a', 'project-a', '/tmp/a.jsonl')`)
	if err != nil {
		t.Fatalf("insert session s1: %v", err)
	}
	_, err = s.DB().Exec(`INSERT INTO sessions (id, project_path, project_name, jsonl_path) VALUES ('s2', '/tmp/b', 'project-b', '/tmp/b.jsonl')`)
	if err != nil {
		t.Fatalf("insert session s2: %v", err)
	}

	// Insert decisions.
	d1 := &DecisionRow{SessionID: "s1", Timestamp: "2025-01-01T00:00:00Z", Topic: "db", DecisionText: "use sqlite", FilePaths: "[]"}
	d2 := &DecisionRow{SessionID: "s2", Timestamp: "2025-01-02T00:00:00Z", Topic: "ui", DecisionText: "use bubbletea", FilePaths: "[]"}

	if err := s.InsertDecision(d1); err != nil {
		t.Fatalf("InsertDecision d1: %v", err)
	}
	if err := s.InsertDecision(d2); err != nil {
		t.Fatalf("InsertDecision d2: %v", err)
	}

	// Get all decisions.
	all, err := s.GetDecisions("", "", 10)
	if err != nil {
		t.Fatalf("GetDecisions all: %v", err)
	}
	if len(all) != 2 {
		t.Errorf("expected 2 decisions, got %d", len(all))
	}

	// Filter by session.
	bySession, err := s.GetDecisions("s1", "", 10)
	if err != nil {
		t.Fatalf("GetDecisions by session: %v", err)
	}
	if len(bySession) != 1 {
		t.Errorf("expected 1 decision for s1, got %d", len(bySession))
	}

	// Filter by project.
	byProject, err := s.GetDecisions("", "project-b", 10)
	if err != nil {
		t.Fatalf("GetDecisions by project: %v", err)
	}
	if len(byProject) != 1 {
		t.Errorf("expected 1 decision for project-b, got %d", len(byProject))
	}
	if len(byProject) > 0 && byProject[0].DecisionText != "use bubbletea" {
		t.Errorf("decision_text = %q, want %q", byProject[0].DecisionText, "use bubbletea")
	}
}

func TestSearchDecisionsFTS(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	_, err = s.DB().Exec(`INSERT INTO sessions (id, project_path, project_name, jsonl_path) VALUES ('s1', '/tmp', 'test', '/tmp/t.jsonl')`)
	if err != nil {
		t.Fatalf("insert session: %v", err)
	}

	decisions := []*DecisionRow{
		{SessionID: "s1", Timestamp: "2025-01-01T00:00:00Z", Topic: "database choice", DecisionText: "decided to use SQLite for local storage", Reasoning: "lightweight and embedded", FilePaths: "[]"},
		{SessionID: "s1", Timestamp: "2025-01-02T00:00:00Z", Topic: "UI framework", DecisionText: "going with Bubble Tea for the TUI", Reasoning: "Go native, good ecosystem", FilePaths: "[]"},
		{SessionID: "s1", Timestamp: "2025-01-03T00:00:00Z", Topic: "search strategy", DecisionText: "opted for hybrid RRF with reranking", Reasoning: "best recall and precision tradeoff", FilePaths: "[]"},
	}
	for _, d := range decisions {
		if err := s.InsertDecision(d); err != nil {
			t.Fatalf("InsertDecision: %v", err)
		}
	}

	// FTS5 search should find by keyword.
	results, err := s.SearchDecisionsFTS("sqlite", "", 10)
	if err != nil {
		t.Fatalf("SearchDecisionsFTS: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected results for 'sqlite'")
	}
	if results[0].Topic != "database choice" {
		t.Errorf("topic = %q, want 'database choice'", results[0].Topic)
	}

	// Porter stemming: "reranking" should match "rerank".
	results, err = s.SearchDecisionsFTS("rerank", "", 10)
	if err != nil {
		t.Fatalf("SearchDecisionsFTS (stemming): %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected results for 'rerank' via stemming")
	}

	// Empty query returns nil.
	results, err = s.SearchDecisionsFTS("", "", 10)
	if err != nil {
		t.Fatalf("SearchDecisionsFTS (empty): %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for empty query, got %d", len(results))
	}
}

