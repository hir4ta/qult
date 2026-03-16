package store

import (
	"context"
	"database/sql"
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

func TestComputeVitality(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert a fresh general memory with some hit count.
	id, _, err := st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/vitality1",
		SectionPath: "project > vitality test",
		Content:     "test content for vitality",
		SourceType:  SourceMemory,
		SubType:     SubTypeGeneral,
	})
	if err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}
	// Increment hit count to 10.
	for i := 0; i < 10; i++ {
		if err := st.IncrementHitCount(ctx, []int64{id}); err != nil {
			t.Fatalf("IncrementHitCount: %v", err)
		}
	}

	vs, err := st.ComputeVitality(ctx, id)
	if err != nil {
		t.Fatalf("ComputeVitality: %v", err)
	}

	// Fresh memory with hits should have a high score.
	if vs.Total < 20 || vs.Total > 100 {
		t.Errorf("ComputeVitality total = %f, want between 20 and 100", vs.Total)
	}
	if vs.RecencyDecay < 0.5 || vs.RecencyDecay > 1.0 {
		t.Errorf("RecencyDecay = %f, want between 0.5 and 1.0", vs.RecencyDecay)
	}
	// 10 hits / 50 cap = 0.2
	if vs.HitCountScore < 0.19 || vs.HitCountScore > 0.21 {
		t.Errorf("HitCountScore = %f, want ~0.2", vs.HitCountScore)
	}
	// General sub_type: boost=1.0, weight=0.0
	if vs.SubTypeWeight != 0.0 {
		t.Errorf("SubTypeWeight = %f, want 0.0 for general", vs.SubTypeWeight)
	}

	// Non-existent record returns error.
	_, err = st.ComputeVitality(ctx, 99999)
	if err == nil {
		t.Error("ComputeVitality(99999) should return error")
	}

	// Non-memory record returns error.
	nonMemID, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/page", SectionPath: "A", Content: "doc", SourceType: "project",
	})
	_, err = st.ComputeVitality(ctx, nonMemID)
	if err == nil {
		t.Error("ComputeVitality on non-memory should return error")
	}
}

func TestComputeVitalityFromDoc(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name     string
		doc      DocRow
		wantMin  float64
		wantMax  float64
	}{
		{
			name: "fresh general no hits",
			doc: DocRow{
				SubType:  SubTypeGeneral,
				CrawledAt: "2026-03-10T12:00:00Z",
				HitCount: 0,
			},
			wantMin: 20.0, // 100 * (0.40*1.0 + 0.25*0 + 0.20*0 + 0.15*0) = 40
			wantMax: 41.0,
		},
		{
			name: "old general no hits",
			doc: DocRow{
				SubType:  SubTypeGeneral,
				CrawledAt: "2025-01-01T00:00:00Z", // >1 year old
				HitCount: 0,
			},
			wantMin: 19.0, // 100 * (0.40*0.5 + 0) = 20
			wantMax: 21.0,
		},
		{
			name: "rule with max hits",
			doc: DocRow{
				SubType:  SubTypeRule,
				CrawledAt: "2026-03-10T12:00:00Z",
				HitCount: 50,
			},
			wantMin: 80.0, // high recency + max hits + rule boost + high freq
			wantMax: 100.0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			vs := ComputeVitalityFromDoc(&tt.doc, now)
			if vs.Total < tt.wantMin || vs.Total > tt.wantMax {
				t.Errorf("ComputeVitalityFromDoc() total = %f, want between %f and %f", vs.Total, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestListLowVitality(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert an old memory with no hits (should have low vitality).
	_, _, err := st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/old",
		SectionPath: "project > old memory",
		Content:     "very old content",
		SourceType:  SourceMemory,
		SubType:     SubTypeGeneral,
		CrawledAt:   time.Now().AddDate(-1, 0, 0).UTC().Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("UpsertDoc(old): %v", err)
	}

	// Insert a fresh memory with hits (should have high vitality).
	freshID, _, err := st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/fresh",
		SectionPath: "project > fresh memory",
		Content:     "fresh content",
		SourceType:  SourceMemory,
		SubType:     SubTypeRule,
	})
	if err != nil {
		t.Fatalf("UpsertDoc(fresh): %v", err)
	}
	for i := 0; i < 20; i++ {
		_ = st.IncrementHitCount(ctx, []int64{freshID})
	}

	results, err := st.ListLowVitality(ctx, 25, 50)
	if err != nil {
		t.Fatalf("ListLowVitality: %v", err)
	}

	// Old memory should be in the results, fresh should not.
	found := false
	for _, r := range results {
		if r.SectionPath == "project > old memory" {
			found = true
			if r.Vitality >= 25 {
				t.Errorf("old memory vitality = %f, want < 25", r.Vitality)
			}
		}
		if r.SectionPath == "project > fresh memory" {
			t.Error("fresh memory should not be in low vitality results")
		}
	}
	if !found {
		t.Error("old memory should be in low vitality results")
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

	// Empty query returns all memories (unfiltered listing).
	results, err = st.SearchMemoriesKeyword(ctx, "", 10)
	if err != nil {
		t.Fatalf("SearchMemoriesKeyword(empty): %v", err)
	}
	if len(results) != 3 {
		t.Errorf("SearchMemoriesKeyword(empty) = %d results, want 3", len(results))
	}

	// Whitespace-only query returns all memories.
	results, err = st.SearchMemoriesKeyword(ctx, "   ", 10)
	if err != nil {
		t.Fatalf("SearchMemoriesKeyword(spaces): %v", err)
	}
	if len(results) != 3 {
		t.Errorf("SearchMemoriesKeyword(spaces) = %d results, want 3", len(results))
	}
}

func TestSchemaV7Migration(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	// Verify V7 columns exist by inserting a record with them.
	ctx := context.Background()
	id, _, err := st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/v7",
		SectionPath: "project > v7 test",
		Content:     "v7 content",
		SourceType:  SourceMemory,
		ValidUntil:  "2030-01-01T00:00:00Z",
		ReviewBy:    "2026-06-01T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("UpsertDoc with V7 columns: %v", err)
	}
	if id == 0 {
		t.Fatal("expected non-zero id")
	}

	// Verify the columns are actually stored.
	var validUntil, reviewBy sql.NullString
	err = st.DB().QueryRowContext(ctx,
		`SELECT valid_until, review_by FROM records WHERE id = ?`, id).Scan(&validUntil, &reviewBy)
	if err != nil {
		t.Fatalf("query V7 columns: %v", err)
	}
	if !validUntil.Valid || validUntil.String != "2030-01-01T00:00:00Z" {
		t.Errorf("valid_until = %v, want 2030-01-01T00:00:00Z", validUntil)
	}
	if !reviewBy.Valid || reviewBy.String != "2026-06-01T00:00:00Z" {
		t.Errorf("review_by = %v, want 2026-06-01T00:00:00Z", reviewBy)
	}

	// Verify superseded_by column exists and defaults to NULL.
	var supersededBy sql.NullInt64
	err = st.DB().QueryRowContext(ctx,
		`SELECT superseded_by FROM records WHERE id = ?`, id).Scan(&supersededBy)
	if err != nil {
		t.Fatalf("query superseded_by: %v", err)
	}
	if supersededBy.Valid {
		t.Errorf("superseded_by should be NULL for new record, got %d", supersededBy.Int64)
	}
}

func TestValidUntilExclusion(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert an expired memory.
	_, _, err := st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/expired",
		SectionPath: "project > expired memory",
		Content:     "this memory has expired",
		SourceType:  SourceMemory,
		ValidUntil:  "2020-01-01T00:00:00Z", // past
	})
	if err != nil {
		t.Fatalf("UpsertDoc(expired): %v", err)
	}

	// Insert a valid memory (no expiry).
	_, _, err = st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/valid",
		SectionPath: "project > valid memory",
		Content:     "this memory is valid",
		SourceType:  SourceMemory,
	})
	if err != nil {
		t.Fatalf("UpsertDoc(valid): %v", err)
	}

	// Insert a memory with future expiry.
	_, _, err = st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/future",
		SectionPath: "project > future memory",
		Content:     "this memory expires in the future",
		SourceType:  SourceMemory,
		ValidUntil:  "2030-01-01T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("UpsertDoc(future): %v", err)
	}

	// ListRecentMemories should exclude expired memory.
	results, err := st.ListRecentMemories(ctx, 50)
	if err != nil {
		t.Fatalf("ListRecentMemories: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("ListRecentMemories = %d results, want 2 (expired excluded)", len(results))
	}
	for _, r := range results {
		if r.SectionPath == "project > expired memory" {
			t.Error("expired memory should not appear in ListRecentMemories")
		}
	}

	// SearchMemoriesKeyword should exclude expired memory.
	results, err = st.SearchMemoriesKeyword(ctx, "memory", 50)
	if err != nil {
		t.Fatalf("SearchMemoriesKeyword: %v", err)
	}
	for _, r := range results {
		if r.SectionPath == "project > expired memory" {
			t.Error("expired memory should not appear in SearchMemoriesKeyword")
		}
	}
}

func TestSupersededByExclusion(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert two memories.
	oldID, _, err := st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/v1",
		SectionPath: "project > versioned",
		Content:     "version 1 content",
		SourceType:  SourceMemory,
	})
	if err != nil {
		t.Fatalf("UpsertDoc(v1): %v", err)
	}

	newID, _, err := st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/v2",
		SectionPath: "project > versioned v2",
		Content:     "version 2 content",
		SourceType:  SourceMemory,
	})
	if err != nil {
		t.Fatalf("UpsertDoc(v2): %v", err)
	}

	// Supersede old version.
	if err := st.SetSupersededBy(ctx, oldID, newID); err != nil {
		t.Fatalf("SetSupersededBy: %v", err)
	}

	// ListRecentMemories should exclude superseded memory.
	results, err := st.ListRecentMemories(ctx, 50)
	if err != nil {
		t.Fatalf("ListRecentMemories: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("ListRecentMemories = %d results, want 1 (superseded excluded)", len(results))
	}
	if len(results) > 0 && results[0].ID != newID {
		t.Errorf("expected new version (id=%d), got id=%d", newID, results[0].ID)
	}
}

func TestReviewDueMemories(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert a memory with past review_by.
	_, _, err := st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/review-due",
		SectionPath: "project > needs review",
		Content:     "this memory needs review",
		SourceType:  SourceMemory,
		ReviewBy:    "2020-01-01T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("UpsertDoc(review-due): %v", err)
	}

	// Insert a memory with future review_by.
	_, _, err = st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/review-ok",
		SectionPath: "project > review ok",
		Content:     "this memory is fine",
		SourceType:  SourceMemory,
		ReviewBy:    "2030-01-01T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("UpsertDoc(review-ok): %v", err)
	}

	// Insert a memory with no review_by.
	_, _, err = st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/no-review",
		SectionPath: "project > no review",
		Content:     "no review date set",
		SourceType:  SourceMemory,
	})
	if err != nil {
		t.Fatalf("UpsertDoc(no-review): %v", err)
	}

	// GetReviewDueMemories should return only the past-due one.
	due, err := st.GetReviewDueMemories(ctx)
	if err != nil {
		t.Fatalf("GetReviewDueMemories: %v", err)
	}
	if len(due) != 1 {
		t.Errorf("GetReviewDueMemories = %d results, want 1", len(due))
	}
	if len(due) > 0 && due[0].SectionPath != "project > needs review" {
		t.Errorf("expected 'needs review', got %q", due[0].SectionPath)
	}

	// Review-due memories should still appear in search results (advisory only).
	results, err := st.SearchMemoriesKeyword(ctx, "review", 50)
	if err != nil {
		t.Fatalf("SearchMemoriesKeyword: %v", err)
	}
	found := false
	for _, r := range results {
		if r.SectionPath == "project > needs review" {
			found = true
		}
	}
	if !found {
		t.Error("review-due memory should still appear in search results")
	}
}

func TestVersionChain(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Create a chain of 3 versions.
	id1, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/chain1", SectionPath: "project > chain", Content: "v1", SourceType: SourceMemory,
	})
	id2, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/chain2", SectionPath: "project > chain", Content: "v2", SourceType: SourceMemory,
	})
	id3, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/chain3", SectionPath: "project > chain", Content: "v3", SourceType: SourceMemory,
	})

	// Chain: id1 → id2 → id3 (oldest → newest).
	if err := st.SetSupersededBy(ctx, id1, id2); err != nil {
		t.Fatalf("SetSupersededBy(1→2): %v", err)
	}
	if err := st.SetSupersededBy(ctx, id2, id3); err != nil {
		t.Fatalf("SetSupersededBy(2→3): %v", err)
	}

	// Forward chain from id1 should reach id2, id3.
	chain, err := st.GetVersionChain(ctx, id1, 5)
	if err != nil {
		t.Fatalf("GetVersionChain: %v", err)
	}
	if len(chain) != 2 {
		t.Errorf("GetVersionChain = %d hops, want 2", len(chain))
	}

	// Reverse chain from id3 should reach id2, id1.
	reverse, err := st.GetReverseVersionChain(ctx, id3, 5)
	if err != nil {
		t.Fatalf("GetReverseVersionChain: %v", err)
	}
	if len(reverse) != 2 {
		t.Errorf("GetReverseVersionChain = %d hops, want 2", len(reverse))
	}

	// Only id3 (head) should appear in search results.
	results, err := st.ListRecentMemories(ctx, 50)
	if err != nil {
		t.Fatalf("ListRecentMemories: %v", err)
	}
	for _, r := range results {
		if r.ID == id1 || r.ID == id2 {
			t.Errorf("superseded record %d should not appear in search results", r.ID)
		}
	}
}

func TestExpiringMemories(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert a memory expiring in 3 days.
	soon := time.Now().Add(3 * 24 * time.Hour).UTC().Format(time.RFC3339)
	_, _, err := st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/expiring-soon",
		SectionPath: "project > expiring soon",
		Content:     "expires soon",
		SourceType:  SourceMemory,
		ValidUntil:  soon,
	})
	if err != nil {
		t.Fatalf("UpsertDoc(expiring-soon): %v", err)
	}

	// Insert a memory expiring in 30 days.
	later := time.Now().Add(30 * 24 * time.Hour).UTC().Format(time.RFC3339)
	_, _, err = st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://test/expiring-later",
		SectionPath: "project > expiring later",
		Content:     "expires later",
		SourceType:  SourceMemory,
		ValidUntil:  later,
	})
	if err != nil {
		t.Fatalf("UpsertDoc(expiring-later): %v", err)
	}

	// GetExpiringMemories(7 days) should return only the soon-expiring one.
	expiring, err := st.GetExpiringMemories(ctx, 7)
	if err != nil {
		t.Fatalf("GetExpiringMemories: %v", err)
	}
	if len(expiring) != 1 {
		t.Errorf("GetExpiringMemories(7) = %d results, want 1", len(expiring))
	}
	if len(expiring) > 0 && expiring[0].SectionPath != "project > expiring soon" {
		t.Errorf("expected 'expiring soon', got %q", expiring[0].SectionPath)
	}
}

func TestSetSupersededByClear(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	id1, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/clear1", SectionPath: "project > clear", Content: "v1", SourceType: SourceMemory,
	})
	id2, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/clear2", SectionPath: "project > clear", Content: "v2", SourceType: SourceMemory,
	})

	// Set superseded_by.
	if err := st.SetSupersededBy(ctx, id1, id2); err != nil {
		t.Fatalf("SetSupersededBy: %v", err)
	}

	// Clear superseded_by (detach from chain).
	if err := st.SetSupersededBy(ctx, id1, 0); err != nil {
		t.Fatalf("SetSupersededBy(clear): %v", err)
	}

	// id1 should now appear in search results again.
	results, err := st.ListRecentMemories(ctx, 50)
	if err != nil {
		t.Fatalf("ListRecentMemories: %v", err)
	}
	found := false
	for _, r := range results {
		if r.ID == id1 {
			found = true
		}
	}
	if !found {
		t.Error("cleared superseded_by record should appear in search results")
	}
}
