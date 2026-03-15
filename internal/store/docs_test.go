package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
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
		SourceType:  "project",
		TTLDays:     7,
	}

	ctx := context.Background()
	id, changed, err := st.UpsertDoc(ctx, doc)
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
	id2, changed2, err := st.UpsertDoc(ctx, doc)
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
	id3, changed3, err := st.UpsertDoc(ctx, doc)
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

func TestGetDocsByIDs(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	var ids []int64
	for i := 0; i < 3; i++ {
		doc := &DocRow{
			URL:         "https://docs.example.com/page",
			SectionPath: "Section " + string(rune('A'+i)),
			Content:     "Content for section " + string(rune('A'+i)),
			SourceType:  "project",
		}
		id, _, err := st.UpsertDoc(context.Background(), doc)
		if err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
		ids = append(ids, id)
	}

	docs, err := st.GetDocsByIDs(context.Background(), ids[:2])
	if err != nil {
		t.Fatalf("GetDocsByIDs: %v", err)
	}
	if len(docs) != 2 {
		t.Errorf("got %d docs, want 2", len(docs))
	}

	// Empty slice.
	empty, err := st.GetDocsByIDs(context.Background(), nil)
	if err != nil {
		t.Fatalf("GetDocsByIDs(nil): %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("got %d docs for nil, want 0", len(empty))
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

func TestDeleteDocsByURLPrefix(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := t.Context()

	// Insert docs with different URL prefixes.
	for _, d := range []DocRow{
		{URL: "https://docs.example.com/hooks", SectionPath: "Hooks", Content: "hooks content", SourceType: "records"},
		{URL: "https://docs.example.com/skills", SectionPath: "Skills", Content: "skills content", SourceType: "records"},
		{URL: "https://other.com/page", SectionPath: "Other", Content: "other content", SourceType: "records"},
	} {
		d2 := d
		if _, _, err := st.UpsertDoc(context.Background(), &d2); err != nil {
			t.Fatalf("UpsertDoc: %v", err)
		}
	}

	// Delete by prefix.
	n, err := st.DeleteDocsByURLPrefix(ctx, "https://docs.example.com/")
	if err != nil {
		t.Fatalf("DeleteDocsByURLPrefix: %v", err)
	}
	if n != 2 {
		t.Errorf("DeleteDocsByURLPrefix deleted %d docs, want 2", n)
	}

	// Verify docs.example.com docs are gone.
	count, err := st.CountDocsByURLPrefix(ctx, "https://docs.example.com/")
	if err != nil {
		t.Fatalf("CountDocsByURLPrefix: %v", err)
	}
	if count != 0 {
		t.Errorf("docs.example.com count = %d, want 0", count)
	}

	// Verify other.com doc still exists.
	count, err = st.CountDocsByURLPrefix(ctx, "https://other.com/")
	if err != nil {
		t.Fatalf("CountDocsByURLPrefix: %v", err)
	}
	if count != 1 {
		t.Errorf("other.com count = %d, want 1", count)
	}
}

func TestEscapeLIKEPrefix(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		prefix string
		want   string
	}{
		{"plain prefix", "https://example.com/", `https://example.com/%`},
		{"percent in prefix", "docs%foo", `docs\%foo%`},
		{"underscore in prefix", "docs_bar", `docs\_bar%`},
		{"backslash in prefix", `docs\path`, `docs\\path%`},
		{"all special chars", `a%b_c\d`, `a\%b\_c\\d%`},
		{"empty prefix", "", `%`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := escapeLIKEPrefix(tt.prefix)
			if got != tt.want {
				t.Errorf("escapeLIKEPrefix(%q) = %q, want %q", tt.prefix, got, tt.want)
			}
		})
	}
}

func TestDeleteDocsByURLPrefix_WildcardSafety(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := t.Context()

	// Insert docs where URL contains LIKE special characters.
	for _, d := range []DocRow{
		{URL: "memory://user/100%_complete/summary", SectionPath: "A", Content: "should survive", SourceType: "memory"},
		{URL: "memory://user/100/real", SectionPath: "B", Content: "should be deleted", SourceType: "memory"},
		{URL: "memory://user/100/other", SectionPath: "C", Content: "should also be deleted", SourceType: "memory"},
		{URL: "spec://project/task_name/design", SectionPath: "D", Content: "task with underscore", SourceType: "spec"},
		{URL: "spec://project/taskXname/design", SectionPath: "E", Content: "similar but different", SourceType: "spec"},
	} {
		d2 := d
		if _, _, err := st.UpsertDoc(ctx, &d2); err != nil {
			t.Fatalf("UpsertDoc: %v", err)
		}
	}

	// Delete with prefix "memory://user/100/" — should NOT match "100%_complete".
	n, err := st.DeleteDocsByURLPrefix(ctx, "memory://user/100/")
	if err != nil {
		t.Fatalf("DeleteDocsByURLPrefix: %v", err)
	}
	if n != 2 {
		t.Errorf("DeleteDocsByURLPrefix(memory://user/100/) = %d, want 2", n)
	}

	// Verify the doc with % in URL still exists.
	count, err := st.CountDocsByURLPrefix(ctx, "memory://user/100%_complete")
	if err != nil {
		t.Fatalf("CountDocsByURLPrefix: %v", err)
	}
	if count != 1 {
		t.Errorf("CountDocsByURLPrefix(100%%_complete) = %d, want 1", count)
	}

	// Delete with prefix containing underscore — should match exactly, not as wildcard.
	n, err = st.DeleteDocsByURLPrefix(ctx, "spec://project/task_name/")
	if err != nil {
		t.Fatalf("DeleteDocsByURLPrefix(task_name): %v", err)
	}
	if n != 1 {
		t.Errorf("DeleteDocsByURLPrefix(task_name) = %d, want 1 (not 2)", n)
	}

	// taskXname doc should still exist.
	count, err = st.CountDocsByURLPrefix(ctx, "spec://project/taskXname/")
	if err != nil {
		t.Fatalf("CountDocsByURLPrefix(taskXname): %v", err)
	}
	if count != 1 {
		t.Errorf("CountDocsByURLPrefix(taskXname) = %d, want 1", count)
	}
}

func TestDeleteDocsByURLPrefix_EmptyPrefix(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := t.Context()

	// Insert a doc so there's data to accidentally delete.
	d := DocRow{URL: "https://example.com/page", SectionPath: "A", Content: "content", SourceType: "records"}
	if _, _, err := st.UpsertDoc(ctx, &d); err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	// DeleteDocsByURLPrefix with empty prefix must return an error.
	_, err := st.DeleteDocsByURLPrefix(ctx, "")
	if err == nil {
		t.Fatal("DeleteDocsByURLPrefix(\"\") = nil, want error")
	}

	// CountDocsByURLPrefix with empty prefix must return an error.
	_, err = st.CountDocsByURLPrefix(ctx, "")
	if err == nil {
		t.Fatal("CountDocsByURLPrefix(\"\") = nil, want error")
	}

	// Original doc must still exist.
	count, err := st.CountDocsByURLPrefix(ctx, "https://example.com/")
	if err != nil {
		t.Fatalf("CountDocsByURLPrefix: %v", err)
	}
	if count != 1 {
		t.Errorf("CountDocsByURLPrefix = %d, want 1 (doc should not have been deleted)", count)
	}
}

func TestDeleteExpiredDocs(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert a doc with TTL=1 day and a crawled_at 2 days ago (expired).
	expired := &DocRow{
		URL:         "https://example.com/expired",
		SectionPath: "Expired",
		Content:     "expired content",
		SourceType:  "project",
		TTLDays:     1,
		CrawledAt:   time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339),
	}
	_, _, err := st.UpsertDoc(ctx, expired)
	if err != nil {
		t.Fatalf("UpsertDoc(expired): %v", err)
	}

	// Insert a doc with TTL=30 days and recent crawled_at (not expired).
	fresh := &DocRow{
		URL:         "https://example.com/fresh",
		SectionPath: "Fresh",
		Content:     "fresh content",
		SourceType:  "project",
		TTLDays:     30,
		CrawledAt:   time.Now().UTC().Format(time.RFC3339),
	}
	_, _, err = st.UpsertDoc(ctx, fresh)
	if err != nil {
		t.Fatalf("UpsertDoc(fresh): %v", err)
	}

	// Insert a memory doc with TTL=0 (permanent, never expires).
	permanent := &DocRow{
		URL:         "memory://test/permanent",
		SectionPath: "project > permanent memory",
		Content:     "permanent memory content",
		SourceType:  SourceMemory,
		TTLDays:     0,
	}
	_, _, err = st.UpsertDoc(ctx, permanent)
	if err != nil {
		t.Fatalf("UpsertDoc(permanent): %v", err)
	}

	n, err := st.DeleteExpiredDocs(ctx)
	if err != nil {
		t.Fatalf("DeleteExpiredDocs: %v", err)
	}
	if n != 1 {
		t.Errorf("DeleteExpiredDocs = %d, want 1", n)
	}

	// Fresh doc should still exist.
	count, err := st.CountDocsByURLPrefix(ctx, "https://example.com/fresh")
	if err != nil {
		t.Fatalf("CountDocsByURLPrefix(fresh): %v", err)
	}
	if count != 1 {
		t.Errorf("fresh doc count = %d, want 1", count)
	}

	// Permanent memory should still exist.
	count, err = st.CountDocsByURLPrefix(ctx, "memory://test/permanent")
	if err != nil {
		t.Fatalf("CountDocsByURLPrefix(permanent): %v", err)
	}
	if count != 1 {
		t.Errorf("permanent doc count = %d, want 1", count)
	}

	// Expired doc should be gone.
	count, err = st.CountDocsByURLPrefix(ctx, "https://example.com/expired")
	if err != nil {
		t.Fatalf("CountDocsByURLPrefix(expired): %v", err)
	}
	if count != 0 {
		t.Errorf("expired doc count = %d, want 0", count)
	}
}

func TestSearchDocsByURLPrefix(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	docs := []DocRow{
		{URL: "https://docs.example.com/hooks/overview", SectionPath: "A", Content: "hooks overview", SourceType: "records"},
		{URL: "https://docs.example.com/hooks/events", SectionPath: "B", Content: "hooks events", SourceType: "records"},
		{URL: "https://docs.example.com/skills/overview", SectionPath: "C", Content: "skills overview", SourceType: "records"},
	}
	for i := range docs {
		if _, _, err := st.UpsertDoc(ctx, &docs[i]); err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}

	// Search by URL prefix.
	results, err := st.SearchDocsByURLPrefix(ctx, "https://docs.example.com/hooks/", 10)
	if err != nil {
		t.Fatalf("SearchDocsByURLPrefix: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("SearchDocsByURLPrefix(hooks) = %d results, want 2", len(results))
	}

	// Results should be ordered by URL.
	if len(results) == 2 && results[0].URL > results[1].URL {
		t.Error("results not ordered by URL")
	}

	// Empty prefix returns error.
	_, err = st.SearchDocsByURLPrefix(ctx, "", 10)
	if err == nil {
		t.Error("SearchDocsByURLPrefix('') should return error")
	}

	// Default limit (0 → 100).
	results, err = st.SearchDocsByURLPrefix(ctx, "https://docs.example.com/", 0)
	if err != nil {
		t.Fatalf("SearchDocsByURLPrefix(limit=0): %v", err)
	}
	if len(results) != 3 {
		t.Errorf("SearchDocsByURLPrefix(limit=0) = %d results, want 3", len(results))
	}
}

func TestSchemaVersion(t *testing.T) {
	t.Parallel()

	v := SchemaVersion()
	if v < 1 {
		t.Errorf("SchemaVersion() = %d, want >= 1", v)
	}
}

func TestSchemaVersionCurrent(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	v := st.SchemaVersionCurrent()
	if v != SchemaVersion() {
		t.Errorf("SchemaVersionCurrent() = %d, want %d", v, SchemaVersion())
	}
}

func TestUpsertDocMemoryTTL(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Memory docs should have TTL=0 (permanent).
	id, _, err := st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/memo",
		SectionPath: "project > memo",
		Content:     "memo content",
		SourceType:  SourceMemory,
	})
	if err != nil {
		t.Fatalf("UpsertDoc(memory): %v", err)
	}

	docs, err := st.GetDocsByIDs(ctx, []int64{id})
	if err != nil {
		t.Fatalf("GetDocsByIDs: %v", err)
	}
	if len(docs) != 1 {
		t.Fatalf("GetDocsByIDs = %d, want 1", len(docs))
	}
	if docs[0].TTLDays != 0 {
		t.Errorf("memory doc TTLDays = %d, want 0", docs[0].TTLDays)
	}
}

func TestSearchMemoriesKeyword(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert some memory docs.
	memories := []DocRow{
		{URL: "memory://proj/1", SectionPath: "project > hook setup", Content: "configured pre-commit hooks for linting", SourceType: SourceMemory},
		{URL: "memory://proj/2", SectionPath: "project > database migration", Content: "added schema v7 with new tables", SourceType: SourceMemory},
		{URL: "memory://proj/3", SectionPath: "project > deployment", Content: "deployed to production with zero downtime", SourceType: SourceMemory},
	}
	for i := range memories {
		if _, _, err := st.UpsertDoc(ctx, &memories[i]); err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}

	// Also insert a non-memory doc with matching content to verify source_type filter.
	_, _, err := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/hooks", SectionPath: "Hooks", Content: "hooks documentation", SourceType: "records",
	})
	if err != nil {
		t.Fatalf("UpsertDoc(docs): %v", err)
	}

	// Search for "hook" — should match memory about hook setup only.
	results, err := st.SearchMemoriesKeyword(ctx, "hook", 10)
	if err != nil {
		t.Fatalf("SearchMemoriesKeyword(hook): %v", err)
	}
	if len(results) != 1 {
		t.Errorf("SearchMemoriesKeyword(hook) = %d results, want 1", len(results))
	}
	if len(results) > 0 && results[0].SectionPath != "project > hook setup" {
		t.Errorf("SearchMemoriesKeyword(hook)[0].SectionPath = %q, want %q", results[0].SectionPath, "project > hook setup")
	}

	// Search for "schema" — should match database migration memory.
	results, err = st.SearchMemoriesKeyword(ctx, "schema", 10)
	if err != nil {
		t.Fatalf("SearchMemoriesKeyword(schema): %v", err)
	}
	if len(results) != 1 {
		t.Errorf("SearchMemoriesKeyword(schema) = %d results, want 1", len(results))
	}

	// Multi-word search: both words must match.
	results, err = st.SearchMemoriesKeyword(ctx, "hook linting", 10)
	if err != nil {
		t.Fatalf("SearchMemoriesKeyword(hook linting): %v", err)
	}
	if len(results) != 1 {
		t.Errorf("SearchMemoriesKeyword(hook linting) = %d results, want 1", len(results))
	}

	// Non-matching multi-word search.
	results, err = st.SearchMemoriesKeyword(ctx, "hook database", 10)
	if err != nil {
		t.Fatalf("SearchMemoriesKeyword(hook database): %v", err)
	}
	if len(results) != 0 {
		t.Errorf("SearchMemoriesKeyword(hook database) = %d results, want 0", len(results))
	}

	// Empty query returns nil.
	results, err = st.SearchMemoriesKeyword(ctx, "", 10)
	if err != nil {
		t.Fatalf("SearchMemoriesKeyword(empty): %v", err)
	}
	if results != nil {
		t.Errorf("SearchMemoriesKeyword(empty) = %v, want nil", results)
	}

	// Whitespace-only query returns nil.
	results, err = st.SearchMemoriesKeyword(ctx, "   ", 10)
	if err != nil {
		t.Fatalf("SearchMemoriesKeyword(spaces): %v", err)
	}
	if results != nil {
		t.Errorf("SearchMemoriesKeyword(spaces) = %v, want nil", results)
	}
}
