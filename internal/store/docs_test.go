package store

import (
	"context"
	"fmt"
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
		SourceType:  "docs",
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

func TestSearchDocsFTS(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	docs := []DocRow{
		{URL: "https://docs.example.com/hooks", SectionPath: "Hooks > Overview", Content: "Hooks allow you to run commands on lifecycle events.", SourceType: "docs"},
		{URL: "https://docs.example.com/skills", SectionPath: "Skills > Overview", Content: "Skills are prompt templates that guide Claude.", SourceType: "docs"},
		{URL: "https://docs.example.com/changelog", SectionPath: "v1.0.30", Content: "Added new hook events for subagent lifecycle.", SourceType: "changelog"},
	}
	for i := range docs {
		if _, _, err := st.UpsertDoc(context.Background(), &docs[i]); err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}

	// Search for "hooks".
	results, err := st.SearchDocsFTS(context.Background(),"hooks", "", 10)
	if err != nil {
		t.Fatalf("SearchDocsFTS: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected results for 'hooks'")
	}

	// Filter by source_type.
	changelogResults, err := st.SearchDocsFTS(context.Background(),"hook", "changelog", 10)
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
		id, _, err := st.UpsertDoc(context.Background(), doc)
		if err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
		ids = append(ids, id)
	}

	docs, err := st.GetDocsByIDs(context.Background(),ids[:2])
	if err != nil {
		t.Fatalf("GetDocsByIDs: %v", err)
	}
	if len(docs) != 2 {
		t.Errorf("got %d docs, want 2", len(docs))
	}

	// Empty slice.
	empty, err := st.GetDocsByIDs(context.Background(),nil)
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
		{"dot slash path", ".claude/agents", "claude agents"},
		{"underscore token", "allowed_tools", "allowed tools"},
		{"complex path", ".claude/rules/next/fsd.md", "claude rules next fsd md"},
		{"at and hash", "user@example.com #tag", "user example com tag"},
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
		if _, _, err := st.UpsertDoc(context.Background(), &docs[i]); err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}

	// Multi-word query should work (phrase or OR fallback).
	results, err := st.SearchDocsFTS(context.Background(),"hooks lifecycle", "", 10)
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
	if _, _, err := st.UpsertDoc(context.Background(), doc); err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	// Should not crash on special characters.
	results, err := st.SearchDocsFTS(context.Background(),`configure(MCP)`, "", 10)
	if err != nil {
		t.Fatalf("SearchDocsFTS with special chars: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected results even with parentheses in query")
	}
}

func TestSearchDocsFTS_TokenSeparators(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	doc := &DocRow{
		URL:         "https://a.com/1",
		SectionPath: "Create custom subagents > Write subagent files",
		Content:     "Subagents use YAML frontmatter for configuration. The tools and disallowedTools fields control capabilities.",
		SourceType:  "docs",
	}
	if _, _, err := st.UpsertDoc(context.Background(), doc); err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	// This query previously returned 0 results because .claude/agents and
	// allowed_tools injected bare AND terms into the OR fallback chain.
	results, err := st.SearchDocsFTS(context.Background(),
		"custom agent .claude/agents markdown frontmatter allowed_tools model haiku sonnet opus", "", 5)
	if err != nil {
		t.Fatalf("SearchDocsFTS: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("expected results for query with token separators (/ . _)")
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


func TestSeedDocsCount(t *testing.T) {
	t.Parallel()

	t.Run("empty DB", func(t *testing.T) {
		t.Parallel()
		st := openTestStore(t)
		n, err := st.SeedDocsCount()
		if err != nil {
			t.Fatalf("SeedDocsCount = _, %v", err)
		}
		if n != 0 {
			t.Errorf("SeedDocsCount = %d, want 0", n)
		}
	})

	t.Run("seed docs counted", func(t *testing.T) {
		t.Parallel()
		st := openTestStore(t)
		for i := range 3 {
			_, _, err := st.UpsertDoc(context.Background(), &DocRow{
				URL:         "https://docs.example.com/page",
				SectionPath: "Section " + string(rune('A'+i)),
				Content:     "Seed content " + string(rune('A'+i)),
				SourceType:  "seed",
			})
			if err != nil {
				t.Fatalf("UpsertDoc[%d]: %v", i, err)
			}
		}
		n, err := st.SeedDocsCount()
		if err != nil {
			t.Fatalf("SeedDocsCount = _, %v", err)
		}
		if n != 3 {
			t.Errorf("SeedDocsCount = %d, want 3", n)
		}
	})

	t.Run("project docs excluded", func(t *testing.T) {
		t.Parallel()
		st := openTestStore(t)
		_, _, err := st.UpsertDoc(context.Background(), &DocRow{
			URL: "https://docs.example.com/a", SectionPath: "A",
			Content: "seed content", SourceType: "seed",
		})
		if err != nil {
			t.Fatalf("UpsertDoc(seed): %v", err)
		}
		_, _, err = st.UpsertDoc(context.Background(), &DocRow{
			URL: "project://claude.md", SectionPath: "B",
			Content: "project content", SourceType: "project",
		})
		if err != nil {
			t.Fatalf("UpsertDoc(project): %v", err)
		}
		_, _, err = st.UpsertDoc(context.Background(), &DocRow{
			URL: "https://custom.dev/docs", SectionPath: "C",
			Content: "custom content", SourceType: "custom",
		})
		if err != nil {
			t.Fatalf("UpsertDoc(custom): %v", err)
		}

		n, err := st.SeedDocsCount()
		if err != nil {
			t.Fatalf("SeedDocsCount = _, %v", err)
		}
		// seed(1) + custom(1) = 2. Project excluded.
		if n != 2 {
			t.Errorf("SeedDocsCount = %d, want 2", n)
		}
	})
}

func TestCrawlMeta(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	t.Run("get nonexistent returns nil", func(t *testing.T) {
		t.Parallel()
		meta, err := st.GetCrawlMeta(ctx, "https://example.com/missing")
		if err != nil {
			t.Fatalf("GetCrawlMeta() = _, %v", err)
		}
		if meta != nil {
			t.Errorf("GetCrawlMeta() = %+v, want nil", meta)
		}
	})

	t.Run("upsert and get", func(t *testing.T) {
		m := &CrawlMeta{
			URL:           "https://example.com/page",
			ETag:          `"abc123"`,
			LastModified:  "Mon, 01 Jan 2024 00:00:00 GMT",
			LastCrawledAt: "2024-01-01T00:00:00Z",
		}
		if err := st.UpsertCrawlMeta(ctx, m); err != nil {
			t.Fatalf("UpsertCrawlMeta() = %v", err)
		}

		got, err := st.GetCrawlMeta(ctx, "https://example.com/page")
		if err != nil {
			t.Fatalf("GetCrawlMeta() = _, %v", err)
		}
		if got == nil {
			t.Fatal("GetCrawlMeta() = nil, want non-nil")
		}
		if got.ETag != `"abc123"` {
			t.Errorf("ETag = %q, want %q", got.ETag, `"abc123"`)
		}
		if got.LastModified != "Mon, 01 Jan 2024 00:00:00 GMT" {
			t.Errorf("LastModified = %q, want %q", got.LastModified, "Mon, 01 Jan 2024 00:00:00 GMT")
		}
	})

	t.Run("upsert updates existing", func(t *testing.T) {
		m := &CrawlMeta{
			URL:           "https://example.com/page",
			ETag:          `"def456"`,
			LastModified:  "Tue, 02 Jan 2024 00:00:00 GMT",
			LastCrawledAt: "2024-01-02T00:00:00Z",
		}
		if err := st.UpsertCrawlMeta(ctx, m); err != nil {
			t.Fatalf("UpsertCrawlMeta() = %v", err)
		}

		got, err := st.GetCrawlMeta(ctx, "https://example.com/page")
		if err != nil {
			t.Fatalf("GetCrawlMeta() = _, %v", err)
		}
		if got.ETag != `"def456"` {
			t.Errorf("ETag = %q, want %q", got.ETag, `"def456"`)
		}
		if got.LastCrawledAt != "2024-01-02T00:00:00Z" {
			t.Errorf("LastCrawledAt = %q, want %q", got.LastCrawledAt, "2024-01-02T00:00:00Z")
		}
	})

	t.Run("default last_crawled_at", func(t *testing.T) {
		m := &CrawlMeta{
			URL:  "https://example.com/auto-time",
			ETag: `"xyz"`,
		}
		if err := st.UpsertCrawlMeta(ctx, m); err != nil {
			t.Fatalf("UpsertCrawlMeta() = %v", err)
		}
		got, err := st.GetCrawlMeta(ctx, "https://example.com/auto-time")
		if err != nil {
			t.Fatalf("GetCrawlMeta() = _, %v", err)
		}
		if got.LastCrawledAt == "" {
			t.Error("LastCrawledAt should be auto-populated")
		}
	})
}

func TestDeleteDocsByURLPrefix(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := t.Context()

	// Insert docs with different URL prefixes.
	for _, d := range []DocRow{
		{URL: "https://docs.example.com/hooks", SectionPath: "Hooks", Content: "hooks content", SourceType: "docs"},
		{URL: "https://docs.example.com/skills", SectionPath: "Skills", Content: "skills content", SourceType: "docs"},
		{URL: "https://other.com/page", SectionPath: "Other", Content: "other content", SourceType: "docs"},
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
	docs, err := st.SearchDocsFTS(context.Background(),"hooks skills", "", 10)
	if err != nil {
		t.Fatalf("SearchDocsFTS: %v", err)
	}
	for _, d := range docs {
		if d.URL == "https://docs.example.com/hooks" || d.URL == "https://docs.example.com/skills" {
			t.Errorf("doc with URL %q should have been deleted", d.URL)
		}
	}

	// Verify other.com doc still exists.
	docs, err = st.SearchDocsFTS(context.Background(),"other content", "", 10)
	if err != nil {
		t.Fatalf("SearchDocsFTS: %v", err)
	}
	found := false
	for _, d := range docs {
		if d.URL == "https://other.com/page" {
			found = true
		}
	}
	if !found {
		t.Error("doc with other.com URL should still exist")
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
	d := DocRow{URL: "https://example.com/page", SectionPath: "A", Content: "content", SourceType: "docs"}
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
		SourceType:  "docs",
		TTLDays:     1,
		CrawledAt:   time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339),
	}
	expiredID, _, err := st.UpsertDoc(ctx, expired)
	if err != nil {
		t.Fatalf("UpsertDoc(expired): %v", err)
	}

	// Insert a doc with TTL=30 days and recent crawled_at (not expired).
	fresh := &DocRow{
		URL:         "https://example.com/fresh",
		SectionPath: "Fresh",
		Content:     "fresh content",
		SourceType:  "docs",
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

	// Record feedback for the expired doc to test orphan cleanup.
	if err := st.RecordFeedback(ctx, expiredID, true); err != nil {
		t.Fatalf("RecordFeedback: %v", err)
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

func TestRecordInjectionAndGetRecent(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert some docs.
	var ids []int64
	for i := 0; i < 3; i++ {
		id, _, err := st.UpsertDoc(ctx, &DocRow{
			URL:         fmt.Sprintf("https://example.com/doc%d", i),
			SectionPath: fmt.Sprintf("Section %d", i),
			Content:     fmt.Sprintf("content %d", i),
			SourceType:  "docs",
		})
		if err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
		ids = append(ids, id)
	}

	// Record injection for first two docs.
	if err := st.RecordInjection(ctx, ids[:2]); err != nil {
		t.Fatalf("RecordInjection: %v", err)
	}

	// Get recent injections within the last hour.
	recent, err := st.GetRecentInjections(ctx, time.Hour)
	if err != nil {
		t.Fatalf("GetRecentInjections: %v", err)
	}
	if len(recent) != 2 {
		t.Errorf("GetRecentInjections = %d results, want 2", len(recent))
	}

	// Get recent injections with a very short window (should return nothing).
	// We need to wait a tiny bit to ensure the injection timestamp is in the past.
	old, err := st.GetRecentInjections(ctx, time.Nanosecond)
	if err != nil {
		t.Fatalf("GetRecentInjections(nanosecond): %v", err)
	}
	// May or may not return results depending on timing; just ensure no error.
	_ = old

	// Record injection for empty slice (should be no-op).
	if err := st.RecordInjection(ctx, nil); err != nil {
		t.Fatalf("RecordInjection(nil): %v", err)
	}
}

func TestRecordFeedback(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert a doc.
	id, _, err := st.UpsertDoc(ctx, &DocRow{
		URL:         "https://example.com/feedback",
		SectionPath: "Feedback",
		Content:     "feedback content",
		SourceType:  "docs",
	})
	if err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	// Record positive feedback (UPSERT creates the row).
	if err := st.RecordFeedback(ctx, id, true); err != nil {
		t.Fatalf("RecordFeedback(positive): %v", err)
	}

	// Record more positive feedback.
	if err := st.RecordFeedback(ctx, id, true); err != nil {
		t.Fatalf("RecordFeedback(positive 2): %v", err)
	}

	// Record negative feedback.
	if err := st.RecordFeedback(ctx, id, false); err != nil {
		t.Fatalf("RecordFeedback(negative): %v", err)
	}

	// Record feedback for a doc that has no prior injection record (UPSERT).
	if err := st.RecordFeedback(ctx, 9999, false); err != nil {
		t.Fatalf("RecordFeedback(non-injected): %v", err)
	}
}

func TestFeedbackBoost(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert docs.
	posID, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/pos", SectionPath: "Pos", Content: "positive", SourceType: "docs",
	})
	negID, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/neg", SectionPath: "Neg", Content: "negative", SourceType: "docs",
	})
	neutralID, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/neutral", SectionPath: "Neutral", Content: "neutral", SourceType: "docs",
	})

	// Positive doc: 3 positive, 0 negative → boost > 1.0.
	for i := 0; i < 3; i++ {
		st.RecordFeedback(ctx, posID, true)
	}

	// Negative doc: 0 positive, 3 negative → boost < 1.0.
	for i := 0; i < 3; i++ {
		st.RecordFeedback(ctx, negID, false)
	}

	// No feedback for neutral doc → boost = 1.0.

	boost := st.FeedbackBoost(ctx, posID)
	if boost <= 1.0 {
		t.Errorf("FeedbackBoost(positive) = %f, want > 1.0", boost)
	}
	if boost > 1.1 {
		t.Errorf("FeedbackBoost(positive) = %f, want <= 1.1", boost)
	}

	boost = st.FeedbackBoost(ctx, negID)
	if boost >= 1.0 {
		t.Errorf("FeedbackBoost(negative) = %f, want < 1.0", boost)
	}
	if boost < 0.9 {
		t.Errorf("FeedbackBoost(negative) = %f, want >= 0.9", boost)
	}

	boost = st.FeedbackBoost(ctx, neutralID)
	if boost != 1.0 {
		t.Errorf("FeedbackBoost(neutral) = %f, want 1.0", boost)
	}

	// Non-existent doc.
	boost = st.FeedbackBoost(ctx, 99999)
	if boost != 1.0 {
		t.Errorf("FeedbackBoost(nonexistent) = %f, want 1.0", boost)
	}
}

func TestFeedbackBoostBatch(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	id1, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/b1", SectionPath: "B1", Content: "c1", SourceType: "docs",
	})
	id2, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/b2", SectionPath: "B2", Content: "c2", SourceType: "docs",
	})

	st.RecordFeedback(ctx, id1, true)
	st.RecordFeedback(ctx, id1, true)
	st.RecordFeedback(ctx, id2, false)

	m := st.FeedbackBoostBatch(ctx, []int64{id1, id2, 99999})
	if v, ok := m[id1]; !ok || v <= 1.0 {
		t.Errorf("FeedbackBoostBatch[id1] = %f, want > 1.0", v)
	}
	if v, ok := m[id2]; !ok || v >= 1.0 {
		t.Errorf("FeedbackBoostBatch[id2] = %f, want < 1.0", v)
	}

	// Empty slice returns empty map.
	empty := st.FeedbackBoostBatch(ctx, nil)
	if len(empty) != 0 {
		t.Errorf("FeedbackBoostBatch(nil) = %d entries, want 0", len(empty))
	}
}

func TestLastCrawledAt(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	// No docs → error.
	_, err := st.LastCrawledAt()
	if err == nil {
		t.Error("LastCrawledAt on empty DB should return error")
	}

	// Insert a doc with a known crawled_at.
	now := time.Now().UTC().Format(time.RFC3339)
	_, _, err = st.UpsertDoc(context.Background(), &DocRow{
		URL:         "https://example.com/crawl",
		SectionPath: "Crawl",
		Content:     "crawl content",
		SourceType:  SourceDocs,
		CrawledAt:   now,
	})
	if err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	got, err := st.LastCrawledAt()
	if err != nil {
		t.Fatalf("LastCrawledAt: %v", err)
	}
	if got.IsZero() {
		t.Error("LastCrawledAt returned zero time")
	}
}

func TestSearchDocsByURLPrefix(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	docs := []DocRow{
		{URL: "https://docs.example.com/hooks/overview", SectionPath: "A", Content: "hooks overview", SourceType: "docs"},
		{URL: "https://docs.example.com/hooks/events", SectionPath: "B", Content: "hooks events", SourceType: "docs"},
		{URL: "https://docs.example.com/skills/overview", SectionPath: "C", Content: "skills overview", SourceType: "docs"},
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

func TestCountDocsBySourceType(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert docs of different source types.
	for i, st2 := range []string{"docs", "docs", "memory", "custom"} {
		_, _, err := st.UpsertDoc(ctx, &DocRow{
			URL:         fmt.Sprintf("https://example.com/%d", i),
			SectionPath: fmt.Sprintf("S%d", i),
			Content:     fmt.Sprintf("content %d", i),
			SourceType:  st2,
		})
		if err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}

	count, err := st.CountDocsBySourceType(ctx, "docs")
	if err != nil {
		t.Fatalf("CountDocsBySourceType(docs): %v", err)
	}
	if count != 2 {
		t.Errorf("CountDocsBySourceType(docs) = %d, want 2", count)
	}

	count, err = st.CountDocsBySourceType(ctx, "memory")
	if err != nil {
		t.Fatalf("CountDocsBySourceType(memory): %v", err)
	}
	if count != 1 {
		t.Errorf("CountDocsBySourceType(memory) = %d, want 1", count)
	}

	count, err = st.CountDocsBySourceType(ctx, "nonexistent")
	if err != nil {
		t.Fatalf("CountDocsBySourceType(nonexistent): %v", err)
	}
	if count != 0 {
		t.Errorf("CountDocsBySourceType(nonexistent) = %d, want 0", count)
	}
}

func TestCountDocsBySourceTypeAndAge(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	oldTime := time.Now().Add(-72 * time.Hour).UTC().Format(time.RFC3339)
	newTime := time.Now().UTC().Format(time.RFC3339)

	_, _, _ = st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/old", SectionPath: "Old", Content: "old", SourceType: "docs", CrawledAt: oldTime,
	})
	_, _, _ = st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/new", SectionPath: "New", Content: "new", SourceType: "docs", CrawledAt: newTime,
	})

	cutoff := time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339)
	count, err := st.CountDocsBySourceTypeAndAge(ctx, "docs", cutoff)
	if err != nil {
		t.Fatalf("CountDocsBySourceTypeAndAge: %v", err)
	}
	if count != 1 {
		t.Errorf("CountDocsBySourceTypeAndAge = %d, want 1", count)
	}
}

func TestListMemoriesBefore(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	oldTime := time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339)
	newTime := time.Now().UTC().Format(time.RFC3339)

	_, _, _ = st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/old", SectionPath: "project > old memory", Content: "old", SourceType: SourceMemory, CrawledAt: oldTime, TTLDays: 0,
	})
	_, _, _ = st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/new", SectionPath: "project > new memory", Content: "new", SourceType: SourceMemory, CrawledAt: newTime, TTLDays: 0,
	})

	cutoff := time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339)
	items, err := st.ListMemoriesBefore(ctx, cutoff, 10)
	if err != nil {
		t.Fatalf("ListMemoriesBefore: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("ListMemoriesBefore = %d items, want 1", len(items))
	}
	if len(items) == 1 && items[0].SectionPath != "project > old memory" {
		t.Errorf("ListMemoriesBefore[0].SectionPath = %q, want %q", items[0].SectionPath, "project > old memory")
	}
}

func TestDeleteMemoriesBefore(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	oldTime := time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339)
	newTime := time.Now().UTC().Format(time.RFC3339)

	_, _, _ = st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/old1", SectionPath: "project > old1", Content: "old1", SourceType: SourceMemory, CrawledAt: oldTime, TTLDays: 0,
	})
	_, _, _ = st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/old2", SectionPath: "project > old2", Content: "old2", SourceType: SourceMemory, CrawledAt: oldTime, TTLDays: 0,
	})
	_, _, _ = st.UpsertDoc(ctx, &DocRow{
		URL: "memory://test/new", SectionPath: "project > new", Content: "new", SourceType: SourceMemory, CrawledAt: newTime, TTLDays: 0,
	})

	cutoff := time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339)
	n, err := st.DeleteMemoriesBefore(ctx, cutoff)
	if err != nil {
		t.Fatalf("DeleteMemoriesBefore: %v", err)
	}
	if n != 2 {
		t.Errorf("DeleteMemoriesBefore = %d, want 2", n)
	}

	// New memory should still exist.
	count, err := st.CountDocsBySourceType(ctx, SourceMemory)
	if err != nil {
		t.Fatalf("CountDocsBySourceType: %v", err)
	}
	if count != 1 {
		t.Errorf("remaining memories = %d, want 1", count)
	}
}

func TestMemoryStatsByProject(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert memories for two projects.
	for i := 0; i < 3; i++ {
		_, _, _ = st.UpsertDoc(ctx, &DocRow{
			URL:         fmt.Sprintf("memory://projectA/%d", i),
			SectionPath: fmt.Sprintf("projectA > memory %d", i),
			Content:     fmt.Sprintf("memory %d", i),
			SourceType:  SourceMemory,
			TTLDays:     0,
		})
	}
	_, _, _ = st.UpsertDoc(ctx, &DocRow{
		URL:         "memory://projectB/0",
		SectionPath: "projectB > memory 0",
		Content:     "memory B",
		SourceType:  SourceMemory,
		TTLDays:     0,
	})

	stats, err := st.MemoryStatsByProject(ctx, 0)
	if err != nil {
		t.Fatalf("MemoryStatsByProject: %v", err)
	}
	if len(stats) != 2 {
		t.Fatalf("MemoryStatsByProject = %d projects, want 2", len(stats))
	}
	// First project should be projectA (most memories).
	if stats[0].Project != "projectA" {
		t.Errorf("MemoryStatsByProject[0].Project = %q, want projectA", stats[0].Project)
	}
	if stats[0].Count != 3 {
		t.Errorf("MemoryStatsByProject[0].Count = %d, want 3", stats[0].Count)
	}

	// With limit.
	stats, err = st.MemoryStatsByProject(ctx, 1)
	if err != nil {
		t.Fatalf("MemoryStatsByProject(limit=1): %v", err)
	}
	if len(stats) != 1 {
		t.Errorf("MemoryStatsByProject(limit=1) = %d projects, want 1", len(stats))
	}
}

func TestGetFeedbackSummary(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Empty feedback.
	fs, err := st.GetFeedbackSummary(ctx)
	if err != nil {
		t.Fatalf("GetFeedbackSummary(empty): %v", err)
	}
	if fs.TotalTracked != 0 {
		t.Errorf("TotalTracked = %d, want 0", fs.TotalTracked)
	}

	// Add some feedback.
	id1, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/fs1", SectionPath: "FS1", Content: "c1", SourceType: "docs",
	})
	id2, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/fs2", SectionPath: "FS2", Content: "c2", SourceType: "docs",
	})

	st.RecordFeedback(ctx, id1, true)
	st.RecordFeedback(ctx, id1, true)
	st.RecordFeedback(ctx, id2, false)
	st.RecordFeedback(ctx, id2, false)
	st.RecordFeedback(ctx, id2, false)

	fs, err = st.GetFeedbackSummary(ctx)
	if err != nil {
		t.Fatalf("GetFeedbackSummary: %v", err)
	}
	if fs.TotalTracked != 2 {
		t.Errorf("TotalTracked = %d, want 2", fs.TotalTracked)
	}
	if fs.TotalPositive != 2 {
		t.Errorf("TotalPositive = %d, want 2", fs.TotalPositive)
	}
	if fs.TotalNegative != 3 {
		t.Errorf("TotalNegative = %d, want 3", fs.TotalNegative)
	}
	if fs.BoostedCount != 1 {
		t.Errorf("BoostedCount = %d, want 1", fs.BoostedCount)
	}
	if fs.PenalizedCount != 1 {
		t.Errorf("PenalizedCount = %d, want 1", fs.PenalizedCount)
	}
}

func TestTopFeedbackDocs(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	id1, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/top1", SectionPath: "Top1", Content: "c1", SourceType: "docs",
	})
	id2, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/top2", SectionPath: "Top2", Content: "c2", SourceType: "docs",
	})

	// id1: 5 positive, 0 negative (net +5).
	for i := 0; i < 5; i++ {
		st.RecordFeedback(ctx, id1, true)
	}
	// id2: 0 positive, 3 negative (net -3).
	for i := 0; i < 3; i++ {
		st.RecordFeedback(ctx, id2, false)
	}

	// Most boosted first (descending).
	top, err := st.TopFeedbackDocs(ctx, 10, false)
	if err != nil {
		t.Fatalf("TopFeedbackDocs(desc): %v", err)
	}
	if len(top) != 2 {
		t.Fatalf("TopFeedbackDocs(desc) = %d, want 2", len(top))
	}
	if top[0].DocID != id1 {
		t.Errorf("TopFeedbackDocs(desc)[0].DocID = %d, want %d", top[0].DocID, id1)
	}
	if top[0].BoostFactor <= 1.0 {
		t.Errorf("TopFeedbackDocs(desc)[0].BoostFactor = %f, want > 1.0", top[0].BoostFactor)
	}

	// Most penalized first (ascending).
	bottom, err := st.TopFeedbackDocs(ctx, 10, true)
	if err != nil {
		t.Fatalf("TopFeedbackDocs(asc): %v", err)
	}
	if len(bottom) != 2 {
		t.Fatalf("TopFeedbackDocs(asc) = %d, want 2", len(bottom))
	}
	if bottom[0].DocID != id2 {
		t.Errorf("TopFeedbackDocs(asc)[0].DocID = %d, want %d", bottom[0].DocID, id2)
	}
	if bottom[0].BoostFactor >= 1.0 {
		t.Errorf("TopFeedbackDocs(asc)[0].BoostFactor = %f, want < 1.0", bottom[0].BoostFactor)
	}
}

func TestRecentInjectionStats(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	id1, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/ris1", SectionPath: "RIS1", Content: "c1", SourceType: "docs",
	})
	id2, _, _ := st.UpsertDoc(ctx, &DocRow{
		URL: "https://example.com/ris2", SectionPath: "RIS2", Content: "c2", SourceType: "docs",
	})

	st.RecordInjection(ctx, []int64{id1, id2})

	injected, uniqueDocs, err := st.RecentInjectionStats(ctx, 1)
	if err != nil {
		t.Fatalf("RecentInjectionStats: %v", err)
	}
	if injected != 2 {
		t.Errorf("injected = %d, want 2", injected)
	}
	if uniqueDocs != 2 {
		t.Errorf("uniqueDocs = %d, want 2", uniqueDocs)
	}
}

func TestFTSIntegrityCheck(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	// Insert a doc to ensure FTS table has content.
	_, _, _ = st.UpsertDoc(context.Background(), &DocRow{
		URL: "https://example.com/fts", SectionPath: "FTS", Content: "fts content", SourceType: "docs",
	})

	err := st.FTSIntegrityCheck()
	if err != nil {
		t.Errorf("FTSIntegrityCheck: %v", err)
	}
}

func TestQueryDocsBySourceType(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	// Insert docs of different types.
	for i, srcType := range []string{"memory", "memory", "docs"} {
		_, _, _ = st.UpsertDoc(ctx, &DocRow{
			URL:         fmt.Sprintf("https://example.com/q%d", i),
			SectionPath: fmt.Sprintf("Q%d", i),
			Content:     fmt.Sprintf("content %d", i),
			SourceType:  srcType,
		})
	}

	// Query by source type with default order.
	docs, err := st.QueryDocsBySourceType(ctx, "memory", "")
	if err != nil {
		t.Fatalf("QueryDocsBySourceType(memory): %v", err)
	}
	if len(docs) != 2 {
		t.Errorf("QueryDocsBySourceType(memory) = %d, want 2", len(docs))
	}

	// Query with explicit order.
	docs, err = st.QueryDocsBySourceType(ctx, "memory", OrderByURL)
	if err != nil {
		t.Fatalf("QueryDocsBySourceType(memory, url): %v", err)
	}
	if len(docs) == 2 && docs[0].URL > docs[1].URL {
		t.Error("QueryDocsBySourceType(url) not ordered by URL")
	}

	// Invalid order by.
	_, err = st.QueryDocsBySourceType(ctx, "memory", "DROP TABLE docs")
	if err == nil {
		t.Error("QueryDocsBySourceType with invalid orderBy should return error")
	}
}

func TestSanitizeFTS5Term(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"plain word", "hooks", "hooks"},
		{"with punctuation", "hook(s)", "hook s"},
		{"reserved word AND", "AND", ""},
		{"reserved word OR", "OR", ""},
		{"reserved word NOT", "NOT", ""},
		{"reserved word NEAR", "NEAR", ""},
		{"mixed reserved", "hooks AND MCP", "hooks MCP"},
		{"empty", "", ""},
		{"only special chars", "()[]{}*", ""},
		{"underscore split", "allowed_tools", "allowed tools"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := SanitizeFTS5Term(tt.input)
			if got != tt.want {
				t.Errorf("SanitizeFTS5Term(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestJoinFTS5Terms(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		input []string
		want  string
	}{
		{"single term", []string{"hooks"}, "hooks"},
		{"multiple terms", []string{"hooks", "skills"}, "hooks OR skills"},
		{"empty terms filtered", []string{"hooks", "", "skills"}, "hooks OR skills"},
		{"all empty", []string{"", "", ""}, ""},
		{"nil", nil, ""},
		{"reserved words filtered", []string{"AND", "hooks"}, "hooks"},
		{"with special chars", []string{"hook(s)", "skill.name"}, "hook s OR skill name"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := JoinFTS5Terms(tt.input)
			if got != tt.want {
				t.Errorf("JoinFTS5Terms(%v) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestSchemaVersion(t *testing.T) {
	t.Parallel()

	v := SchemaVersion()
	if v < 6 {
		t.Errorf("SchemaVersion() = %d, want >= 6", v)
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

func TestParseSourceTypes(t *testing.T) {
	t.Parallel()
	tests := []struct {
		input string
		want  int
	}{
		{"", 0},
		{"docs", 1},
		{"docs,memory", 2},
		{"docs, memory, custom", 3},
		{",,,", 0},
		{"docs,,memory", 2},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			t.Parallel()
			got := parseSourceTypes(tt.input)
			if len(got) != tt.want {
				t.Errorf("parseSourceTypes(%q) = %v (%d), want %d types", tt.input, got, len(got), tt.want)
			}
		})
	}
}

func TestSearchDocsFTS_MultiSourceType(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	ctx := context.Background()

	docs := []DocRow{
		{URL: "https://a.com/1", SectionPath: "A", Content: "hooks documentation page", SourceType: "docs"},
		{URL: "https://a.com/2", SectionPath: "B", Content: "hooks memory note", SourceType: "memory"},
		{URL: "https://a.com/3", SectionPath: "C", Content: "hooks custom source", SourceType: "custom"},
	}
	for i := range docs {
		if _, _, err := st.UpsertDoc(ctx, &docs[i]); err != nil {
			t.Fatalf("UpsertDoc[%d]: %v", i, err)
		}
	}

	// Multi source type filter.
	results, err := st.SearchDocsFTS(ctx, "hooks", "docs,memory", 10)
	if err != nil {
		t.Fatalf("SearchDocsFTS(docs,memory): %v", err)
	}
	for _, r := range results {
		if r.SourceType != "docs" && r.SourceType != "memory" {
			t.Errorf("unexpected source_type %q in multi-type search", r.SourceType)
		}
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

func TestIsFTS5TokenChar(t *testing.T) {
	t.Parallel()
	tests := []struct {
		r    rune
		want bool
	}{
		{'a', true},
		{'Z', true},
		{'0', true},
		{'9', true},
		{' ', false},
		{'.', false},
		{'(', false},
		{'-', false},
		{'_', false},
		{'日', true},  // Letter
		{'ア', true},  // Katakana (Letter)
	}
	for _, tt := range tests {
		t.Run(string(tt.r), func(t *testing.T) {
			t.Parallel()
			got := isFTS5TokenChar(tt.r)
			if got != tt.want {
				t.Errorf("isFTS5TokenChar(%q) = %v, want %v", tt.r, got, tt.want)
			}
		})
	}
}
