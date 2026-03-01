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

func TestGetDoc(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	doc := &DocRow{
		URL:         "https://docs.example.com/skills",
		SectionPath: "Skills > Overview",
		Content:     "Skills are reusable prompt templates.",
		SourceType:  "docs",
		TTLDays:     14,
	}
	id, _, err := st.UpsertDoc(doc)
	if err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	got, err := st.GetDoc(id)
	if err != nil {
		t.Fatalf("GetDoc: %v", err)
	}
	if got.URL != doc.URL {
		t.Errorf("URL = %q, want %q", got.URL, doc.URL)
	}
	if got.SectionPath != doc.SectionPath {
		t.Errorf("SectionPath = %q, want %q", got.SectionPath, doc.SectionPath)
	}
	if got.Content != doc.Content {
		t.Errorf("Content = %q, want %q", got.Content, doc.Content)
	}
	if got.TTLDays != 14 {
		t.Errorf("TTLDays = %d, want 14", got.TTLDays)
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

func TestSearchDocsLIKE(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	doc := &DocRow{
		URL:         "https://docs.example.com/mcp",
		SectionPath: "MCP > Configuration",
		Content:     "Configure MCP servers in .mcp.json or .claude/mcp.json.",
		SourceType:  "docs",
	}
	if _, _, err := st.UpsertDoc(doc); err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	results, err := st.SearchDocsLIKE("mcp.json", 10)
	if err != nil {
		t.Fatalf("SearchDocsLIKE: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected results for 'mcp.json'")
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

func TestDocsStats(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	docs := []DocRow{
		{URL: "https://a.com/1", SectionPath: "S1", Content: "c1", SourceType: "docs"},
		{URL: "https://a.com/2", SectionPath: "S2", Content: "c2", SourceType: "docs"},
		{URL: "https://a.com/3", SectionPath: "S3", Content: "c3", SourceType: "changelog"},
	}
	for i := range docs {
		st.UpsertDoc(&docs[i])
	}

	total, bySource, _, err := st.DocsStats()
	if err != nil {
		t.Fatalf("DocsStats: %v", err)
	}
	if total != 3 {
		t.Errorf("total = %d, want 3", total)
	}
	if bySource["docs"] != 2 {
		t.Errorf("docs count = %d, want 2", bySource["docs"])
	}
	if bySource["changelog"] != 1 {
		t.Errorf("changelog count = %d, want 1", bySource["changelog"])
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
