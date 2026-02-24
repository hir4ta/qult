package store

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestExtractDecisions_English(t *testing.T) {
	assistant := "After reviewing the options, I decided to use SQLite for local storage. This will use WAL mode for concurrency."
	user := "What database should we use?"

	decisions := ExtractDecisions(assistant, user, "2025-01-01T00:00:00Z")

	if len(decisions) == 0 {
		t.Fatal("expected at least one decision, got 0")
	}

	found := false
	for _, d := range decisions {
		if containsStr(d.DecisionText, "decided to use SQLite") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected decision containing 'decided to use SQLite', got: %+v", decisions)
	}

	// Topic should be the user text.
	if decisions[0].Topic != user {
		t.Errorf("topic = %q, want %q", decisions[0].Topic, user)
	}
}

func TestExtractDecisions_Japanese(t *testing.T) {
	assistant := "SQLiteを採用します。WALモードで並行処理を行う方針です。"
	user := "どのデータベースを使いますか？"

	decisions := ExtractDecisions(assistant, user, "2025-01-01T00:00:00Z")

	if len(decisions) == 0 {
		t.Fatal("expected at least one decision from Japanese text, got 0")
	}

	foundAdopt := false
	foundPolicy := false
	for _, d := range decisions {
		if containsStr(d.DecisionText, "を採用") {
			foundAdopt = true
		}
		if containsStr(d.DecisionText, "方針") {
			foundPolicy = true
		}
	}
	if !foundAdopt {
		t.Errorf("expected decision containing 'を採用', got: %+v", decisions)
	}
	if !foundPolicy {
		t.Errorf("expected decision containing '方針', got: %+v", decisions)
	}
}

func TestExtractDecisions_FilePaths(t *testing.T) {
	assistant := "I decided to put the schema in `internal/store/schema.go` and the main logic in internal/store/store.go."
	user := "Where should the files go?"

	decisions := ExtractDecisions(assistant, user, "2025-01-01T00:00:00Z")

	if len(decisions) == 0 {
		t.Fatal("expected at least one decision, got 0")
	}

	var paths []string
	if err := json.Unmarshal([]byte(decisions[0].FilePaths), &paths); err != nil {
		t.Fatalf("failed to parse file_paths JSON: %v", err)
	}

	if len(paths) < 2 {
		t.Fatalf("expected at least 2 file paths, got %d: %v", len(paths), paths)
	}

	expected := map[string]bool{
		"internal/store/schema.go": true,
		"internal/store/store.go":  true,
	}
	for _, p := range paths {
		if !expected[p] {
			t.Errorf("unexpected path: %s", p)
		}
	}
}

func TestExtractDecisions_NoKeywords(t *testing.T) {
	assistant := "Here is the code you requested. It creates a simple HTTP server."
	user := "Write me a server."

	decisions := ExtractDecisions(assistant, user, "2025-01-01T00:00:00Z")

	if len(decisions) != 0 {
		t.Errorf("expected 0 decisions when no keywords present, got %d: %+v", len(decisions), decisions)
	}
}

func TestExtractDecisions_EmptyText(t *testing.T) {
	decisions := ExtractDecisions("", "question", "2025-01-01T00:00:00Z")
	if decisions != nil {
		t.Errorf("expected nil for empty assistant text, got %+v", decisions)
	}
}

func TestExtractDecisions_TopicTruncation(t *testing.T) {
	longUser := ""
	for i := 0; i < 120; i++ {
		longUser += "a"
	}

	assistant := "I decided to keep it short."
	decisions := ExtractDecisions(assistant, longUser, "2025-01-01T00:00:00Z")

	if len(decisions) == 0 {
		t.Fatal("expected at least one decision")
	}
	if len([]rune(decisions[0].Topic)) != 100 {
		t.Errorf("topic length = %d, want 100", len([]rune(decisions[0].Topic)))
	}
}

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

	// Search by FTS.
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

func containsStr(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && findSubstr(s, substr))
}

func findSubstr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
