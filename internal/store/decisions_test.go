package store

import (
	"encoding/json"
	"path/filepath"
	"strings"
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

func TestSearchDecisionsByFile(t *testing.T) {
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
		{
			SessionID:    "s1",
			Timestamp:    "2025-01-01T00:00:00Z",
			Topic:        "store package design",
			DecisionText: "use SQLite for persistence",
			FilePaths:    `["internal/store/store.go", "internal/store/decisions.go"]`,
		},
		{
			SessionID:    "s1",
			Timestamp:    "2025-01-02T00:00:00Z",
			Topic:        "unrelated decision",
			DecisionText: "use bubbletea for TUI",
			FilePaths:    `["internal/tui/model.go"]`,
		},
	}
	for _, d := range decisions {
		if err := s.InsertDecision(d); err != nil {
			t.Fatalf("InsertDecision: %v", err)
		}
	}

	// Should find by basename match.
	results, err := s.SearchDecisionsByFile("internal/store/store.go", 10)
	if err != nil {
		t.Fatalf("SearchDecisionsByFile: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result for store.go, got %d", len(results))
	}
	if results[0].Topic != "store package design" {
		t.Errorf("topic = %q, want 'store package design'", results[0].Topic)
	}

	// Basename-only path should also match.
	results, err = s.SearchDecisionsByFile("decisions.go", 10)
	if err != nil {
		t.Fatalf("SearchDecisionsByFile (basename): %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result for decisions.go, got %d", len(results))
	}

	// Non-existent file returns empty.
	results, err = s.SearchDecisionsByFile("nonexistent.go", 10)
	if err != nil {
		t.Fatalf("SearchDecisionsByFile (missing): %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for missing file, got %d", len(results))
	}
}

func TestSearchDecisionsByFile_SuffixDisambiguation(t *testing.T) {
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

	// Two decisions referencing files with the same basename but different directories.
	decisions := []*DecisionRow{
		{
			SessionID:    "s1",
			Timestamp:    "2025-01-01T00:00:00Z",
			Topic:        "store model",
			DecisionText: "store model design",
			FilePaths:    `["internal/store/model.go"]`,
		},
		{
			SessionID:    "s1",
			Timestamp:    "2025-01-02T00:00:00Z",
			Topic:        "tui model",
			DecisionText: "tui model design",
			FilePaths:    `["internal/tui/model.go"]`,
		},
	}
	for _, d := range decisions {
		if err := s.InsertDecision(d); err != nil {
			t.Fatalf("InsertDecision: %v", err)
		}
	}

	// Searching with full path should match only the correct directory.
	results, err := s.SearchDecisionsByFile("internal/store/model.go", 10)
	if err != nil {
		t.Fatalf("SearchDecisionsByFile: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result for store/model.go, got %d", len(results))
	}
	if results[0].Topic != "store model" {
		t.Errorf("topic = %q, want 'store model'", results[0].Topic)
	}

	results, err = s.SearchDecisionsByFile("internal/tui/model.go", 10)
	if err != nil {
		t.Fatalf("SearchDecisionsByFile: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result for tui/model.go, got %d", len(results))
	}
	if results[0].Topic != "tui model" {
		t.Errorf("topic = %q, want 'tui model'", results[0].Topic)
	}
}

func TestPathSuffix(t *testing.T) {
	t.Parallel()
	cases := []struct {
		input string
		want  string
	}{
		{"/Users/user/Projects/app/internal/store/events.go", "store/events.go"},
		{"internal/store/events.go", "store/events.go"},
		{"store/events.go", "store/events.go"},
		{"events.go", "events.go"},
		{"/events.go", "events.go"},
		{"", "."},
	}
	for _, tc := range cases {
		t.Run(tc.input, func(t *testing.T) {
			t.Parallel()
			got := PathSuffix(tc.input)
			if got != tc.want {
				t.Errorf("PathSuffix(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestSearchDecisionsByDirectory(t *testing.T) {
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
		{
			SessionID:    "s1",
			Timestamp:    "2025-01-01T00:00:00Z",
			Topic:        "store design",
			DecisionText: "use SQLite",
			FilePaths:    `["internal/store/store.go"]`,
		},
		{
			SessionID:    "s1",
			Timestamp:    "2025-01-02T00:00:00Z",
			Topic:        "TUI design",
			DecisionText: "use bubbletea",
			FilePaths:    `["internal/tui/model.go"]`,
		},
		{
			SessionID:    "s1",
			Timestamp:    "2025-01-03T00:00:00Z",
			Topic:        "another store file",
			DecisionText: "decisions table schema",
			FilePaths:    `["internal/store/decisions.go"]`,
		},
	}
	for _, d := range decisions {
		if err := s.InsertDecision(d); err != nil {
			t.Fatalf("InsertDecision: %v", err)
		}
	}

	// Should match files under internal/store/.
	results, err := s.SearchDecisionsByDirectory("internal/store", 10)
	if err != nil {
		t.Fatalf("SearchDecisionsByDirectory: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results for internal/store, got %d", len(results))
	}

	// Should match only tui files.
	results, err = s.SearchDecisionsByDirectory("internal/tui", 10)
	if err != nil {
		t.Fatalf("SearchDecisionsByDirectory (tui): %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result for internal/tui, got %d", len(results))
	}

	// LIKE-special characters in directory path should not cause SQL errors.
	results, err = s.SearchDecisionsByDirectory("internal/store_%special", 10)
	if err != nil {
		t.Fatalf("SearchDecisionsByDirectory (special chars): %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for non-existent dir, got %d", len(results))
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

// ---------------------------------------------------------------------------
// ExtractDecisions (rule-based keyword matching)
// ---------------------------------------------------------------------------

func TestExtractDecisions_English(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		text    string
		wantMin int
		wantSub string
	}{
		{"decided to", "I decided to use SQLite for local storage.", 1, "decided to use SQLite"},
		{"opted for", "We opted for WAL mode for concurrent access.", 1, "opted for WAL"},
		{"going with", "Going with embedded storage instead of client-server.", 1, "Going with embedded"},
		{"instead of", "Using channels instead of mutexes for synchronization.", 1, "instead of"},
		{"switched to", "Switched to bubbletea from termbox.", 1, "Switched to bubbletea"},
		{"replaced with", "The old parser was replaced with a streaming JSON approach.", 1, "replaced with"},
		{"will use", "We will use Go 1.25 for this project.", 1, "will use Go"},
		{"recommend using", "I recommend using FTS5 for full-text search.", 1, "recommend using FTS5"},
		{"approach:", "Approach: use hybrid vector + FTS5 with RRF.", 1, "Approach"},
		{"let's go with", "Let's go with option B for simplicity.", 1, "go with option B"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			decisions := ExtractDecisions(tc.text, "2025-01-01T00:00:00Z")
			if len(decisions) < tc.wantMin {
				t.Fatalf("ExtractDecisions(%q) = %d decisions, want >= %d", tc.text, len(decisions), tc.wantMin)
			}
			if !strings.Contains(decisions[0].DecisionText, tc.wantSub) {
				t.Errorf("decision_text = %q, want substring %q", decisions[0].DecisionText, tc.wantSub)
			}
		})
	}
}

func TestExtractDecisions_Japanese(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		text    string
		wantMin int
		wantSub string
	}{
		{"にしました", "SQLiteをデータベースにしました。", 1, "SQLite"},
		{"にします", "WALモードにします。", 1, "WAL"},
		{"を選択", "FTS5を選択しました。", 1, "FTS5"},
		{"を採用", "Bubble Teaを採用します。", 1, "Bubble Tea"},
		{"を使うことに", "fsnotifyを使うことにしました。", 1, "fsnotify"},
		{"に変更", "スキーマをV2に変更しました。", 1, "に変更"},
		{"に切り替え", "WALモードに切り替えました。", 1, "に切り替え"},
		{"ではなく", "mutexではなくchannelを使います。", 1, "ではなく"},
		{"の代わりに", "termboxの代わりにbubbletea。", 1, "の代わりに"},
		{"方式で", "ハイブリッド方式で検索します。", 1, "方式で"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			decisions := ExtractDecisions(tc.text, "2025-01-01T00:00:00Z")
			if len(decisions) < tc.wantMin {
				t.Fatalf("ExtractDecisions(%q) = %d decisions, want >= %d", tc.text, len(decisions), tc.wantMin)
			}
			if !strings.Contains(decisions[0].DecisionText, tc.wantSub) {
				t.Errorf("decision_text = %q, want substring %q", decisions[0].DecisionText, tc.wantSub)
			}
		})
	}
}

func TestExtractDecisions_MultipleKeywords(t *testing.T) {
	t.Parallel()
	text := "I decided to use SQLite. We opted for WAL mode. Going with embedded storage."
	decisions := ExtractDecisions(text, "2025-01-01T00:00:00Z")
	if len(decisions) < 3 {
		t.Fatalf("expected >= 3 decisions, got %d: %+v", len(decisions), decisions)
	}
}

func TestExtractDecisions_FilePaths(t *testing.T) {
	t.Parallel()
	text := "I decided to put the schema in `internal/store/schema.go` and logic in internal/store/store.go."
	decisions := ExtractDecisions(text, "2025-01-01T00:00:00Z")
	if len(decisions) == 0 {
		t.Fatal("expected at least one decision")
	}

	var paths []string
	if err := json.Unmarshal([]byte(decisions[0].FilePaths), &paths); err != nil {
		t.Fatalf("parse file_paths: %v", err)
	}
	if len(paths) < 2 {
		t.Fatalf("expected >= 2 file paths, got %d: %v", len(paths), paths)
	}
}

func TestExtractDecisions_NoKeywords(t *testing.T) {
	t.Parallel()
	text := "Here is the code you requested. It creates a simple HTTP server."
	decisions := ExtractDecisions(text, "2025-01-01T00:00:00Z")
	if len(decisions) != 0 {
		t.Errorf("expected 0 decisions, got %d: %+v", len(decisions), decisions)
	}
}

func TestExtractDecisions_EmptyText(t *testing.T) {
	t.Parallel()
	decisions := ExtractDecisions("", "2025-01-01T00:00:00Z")
	if decisions != nil {
		t.Errorf("expected nil for empty text, got %+v", decisions)
	}
}

func TestExtractDecisions_TopicTruncation(t *testing.T) {
	t.Parallel()
	// Build a sentence that triggers a keyword and exceeds 80 runes.
	long := "I decided to " + strings.Repeat("implement a very elaborate system ", 5)
	decisions := ExtractDecisions(long, "2025-01-01T00:00:00Z")
	if len(decisions) == 0 {
		t.Fatal("expected at least one decision")
	}
	if runeLen := len([]rune(decisions[0].Topic)); runeLen > 80 {
		t.Errorf("topic rune length = %d, want <= 80", runeLen)
	}
}

func TestExtractDecisions_CapsAt5(t *testing.T) {
	t.Parallel()
	var sentences []string
	for i := 0; i < 8; i++ {
		sentences = append(sentences, "I decided to do thing number something")
	}
	text := strings.Join(sentences, ". ") + "."
	decisions := ExtractDecisions(text, "2025-01-01T00:00:00Z")
	if len(decisions) > 5 {
		t.Errorf("expected <= 5 decisions (capped), got %d", len(decisions))
	}
}

func TestExtractDecisions_Deduplication(t *testing.T) {
	t.Parallel()
	text := "I decided to use SQLite.\nI decided to use SQLite.\nI decided to use SQLite."
	decisions := ExtractDecisions(text, "2025-01-01T00:00:00Z")
	if len(decisions) != 1 {
		t.Errorf("expected 1 deduplicated decision, got %d", len(decisions))
	}
}

