package store

import (
	"path/filepath"
	"testing"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	st, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func TestUpsertDoc(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	doc := &DocRow{
		URL:         "https://docs.example.com/hooks",
		SectionPath: "Hooks > PreToolUse",
		Content:     "PreToolUse hooks fire before a tool is called.",
		SourceType:  "docs",
		TTLDays:     7,
	}

	id, changed, err := st.UpsertDoc(doc)
	if err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}
	if !changed {
		t.Error("expected changed=true for new doc")
	}
	if id == 0 {
		t.Error("expected non-zero id")
	}

	// Upsert same content → unchanged.
	id2, changed2, err := st.UpsertDoc(doc)
	if err != nil {
		t.Fatalf("UpsertDoc (same): %v", err)
	}
	if changed2 {
		t.Error("expected changed=false for identical content")
	}
	if id2 != id {
		t.Errorf("id changed: %d → %d", id, id2)
	}

	// Upsert with different content → changed.
	doc.Content = "Updated content for hooks."
	id3, changed3, err := st.UpsertDoc(doc)
	if err != nil {
		t.Fatalf("UpsertDoc (updated): %v", err)
	}
	if !changed3 {
		t.Error("expected changed=true for updated content")
	}
	if id3 == 0 {
		t.Error("expected non-zero id after update")
	}
}

func TestSearchDocsFTS(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	docs := []DocRow{
		{URL: "https://docs.example.com/hooks", SectionPath: "Hooks > Overview", Content: "Hooks allow you to run commands on lifecycle events.", SourceType: "docs"},
		{URL: "https://docs.example.com/skills", SectionPath: "Skills > Overview", Content: "Skills are prompt templates that guide Claude.", SourceType: "docs"},
		{URL: "https://docs.example.com/changelog", SectionPath: "v1.0.30", Content: "Added new hook events for subagent lifecycle.", SourceType: "changelog"},
	}
	for i := range docs {
		if _, _, err := st.UpsertDoc(&docs[i]); err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}

	// Search for "hooks".
	results, err := st.SearchDocsFTS("hooks", "", 10)
	if err != nil {
		t.Fatalf("SearchDocsFTS: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected results for 'hooks'")
	}

	// Filter by source_type.
	changelogResults, err := st.SearchDocsFTS("hook", "changelog", 10)
	if err != nil {
		t.Fatalf("SearchDocsFTS (changelog): %v", err)
	}
	for _, r := range changelogResults {
		if r.SourceType != "changelog" {
			t.Errorf("expected source_type=changelog, got %q", r.SourceType)
		}
	}
}

func TestGetDocsByIDs(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	var ids []int64
	for i := 0; i < 3; i++ {
		doc := &DocRow{
			URL:         "https://docs.example.com/page",
			SectionPath: "Section " + string(rune('A'+i)),
			Content:     "Content for section " + string(rune('A'+i)),
			SourceType:  "docs",
		}
		id, _, err := st.UpsertDoc(doc)
		if err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
		ids = append(ids, id)
	}

	docs, err := st.GetDocsByIDs(ids[:2])
	if err != nil {
		t.Fatalf("GetDocsByIDs: %v", err)
	}
	if len(docs) != 2 {
		t.Errorf("got %d docs, want 2", len(docs))
	}

	// Empty slice.
	empty, err := st.GetDocsByIDs(nil)
	if err != nil {
		t.Fatalf("GetDocsByIDs(nil): %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("got %d docs for nil, want 0", len(empty))
	}
}

func TestSanitizeFTS5Query(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"empty", "", ""},
		{"single short word with prefix expansion", "hook", "hook*"},
		{"single long word no expansion", "configuration", "configuration"},
		{"parentheses stripped", "hook(s)", "hook s"},
		{"quotes stripped", `"hello world"`, "hello world"},
		{"reserved words removed", "hooks AND MCP", "hooks MCP"},
		{"all reserved", "AND OR NOT", ""},
		{"leading minus stripped", "-forbidden test", "forbidden test"},
		{"special chars combo", `test+case^foo:bar`, "test case foo bar"},
		{"single char preserved", "a", "a"},
		{"two chars preserved", "go", "go"},
		{"3 char gets prefix", "mcp", "mcp*"},
		{"6 char gets prefix", "agents", "agents*"},
		{"7 char no prefix", "worktree", "worktree"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := SanitizeFTS5Query(tt.input)
			if got != tt.want {
				t.Errorf("SanitizeFTS5Query(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestSearchDocsFTS_PhraseFirst(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	docs := []DocRow{
		{URL: "https://a.com/1", SectionPath: "A", Content: "PreToolUse hooks fire before a tool is called", SourceType: "docs"},
		{URL: "https://a.com/2", SectionPath: "B", Content: "Hooks overview and lifecycle events documentation", SourceType: "docs"},
		{URL: "https://a.com/3", SectionPath: "C", Content: "Tools for debugging and inspection", SourceType: "docs"},
	}
	for i := range docs {
		if _, _, err := st.UpsertDoc(&docs[i]); err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}

	// Multi-word query should work (phrase or OR fallback).
	results, err := st.SearchDocsFTS("hooks lifecycle", "", 10)
	if err != nil {
		t.Fatalf("SearchDocsFTS: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected results for multi-word query")
	}
}

func TestSearchDocsFTS_SpecialChars(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	doc := &DocRow{
		URL: "https://a.com/1", SectionPath: "Test", Content: "Configure MCP servers properly", SourceType: "docs",
	}
	if _, _, err := st.UpsertDoc(doc); err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	// Should not crash on special characters.
	results, err := st.SearchDocsFTS(`configure(MCP)`, "", 10)
	if err != nil {
		t.Fatalf("SearchDocsFTS with special chars: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected results even with parentheses in query")
	}
}

func TestContentHashOf(t *testing.T) {
	t.Parallel()
	h1 := ContentHashOf("hello")
	h2 := ContentHashOf("hello")
	h3 := ContentHashOf("world")
	if h1 != h2 {
		t.Error("same content should produce same hash")
	}
	if h1 == h3 {
		t.Error("different content should produce different hash")
	}
}
