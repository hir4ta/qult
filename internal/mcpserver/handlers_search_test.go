package mcpserver

import (
	"context"
	"testing"
	"time"

	"github.com/hir4ta/claude-alfred/internal/store"
)

func TestKnowledgeHandler_LimitDefault(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := docsSearchHandler(st, nil, nil)

	// Insert several docs.
	for i := range 8 {
		doc := &store.DocRow{
			URL:         "https://example.com/doc" + string(rune('a'+i)),
			SectionPath: "Section " + string(rune('A'+i)),
			Content:     "Hooks lifecycle events automation number " + string(rune('0'+i)),
			SourceType:  "docs",
		}
		doc.ContentHash = store.ContentHashOf(doc.Content)
		if _, _, err := st.UpsertDoc(doc); err != nil {
			t.Fatalf("UpsertDoc: %v", err)
		}
	}

	// Default limit = 5; should return at most 5 results.
	res, err := handler(context.Background(), newRequest(map[string]any{
		"query": "hooks lifecycle",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m := resultJSON(t, res)
	docsCount, _ := m["docs_count"].(float64)
	if docsCount > 5 {
		t.Errorf("docs_count = %v, want <= 5 (default limit)", docsCount)
	}
	if method, _ := m["search_method"].(string); method != "hybrid_rrf" {
		t.Errorf("search_method = %q, want hybrid_rrf (FTS fallback)", method)
	}
}

func TestKnowledgeHandler_LimitNegativeDefaultsTo5(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := docsSearchHandler(st, nil, nil)

	doc := &store.DocRow{
		URL:         "https://example.com/neg",
		SectionPath: "NegLimit",
		Content:     "Testing negative limit behavior",
		SourceType:  "docs",
	}
	doc.ContentHash = store.ContentHashOf(doc.Content)
	if _, _, err := st.UpsertDoc(doc); err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"query": "negative limit",
		"limit": -1,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}
}

func TestKnowledgeHandler_CustomLimit(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := docsSearchHandler(st, nil, nil)

	for i := range 5 {
		doc := &store.DocRow{
			URL:         "https://example.com/lim" + string(rune('a'+i)),
			SectionPath: "Limit " + string(rune('A'+i)),
			Content:     "Claude hooks automation custom limit test " + string(rune('0'+i)),
			SourceType:  "docs",
		}
		doc.ContentHash = store.ContentHashOf(doc.Content)
		if _, _, err := st.UpsertDoc(doc); err != nil {
			t.Fatalf("UpsertDoc: %v", err)
		}
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"query": "hooks automation",
		"limit": 2,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m := resultJSON(t, res)
	docsCount, _ := m["docs_count"].(float64)
	if docsCount > 2 {
		t.Errorf("docs_count = %v, want <= 2", docsCount)
	}
}

func TestKnowledgeHandler_VersionAndFreshness(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := docsSearchHandler(st, nil, nil)

	// Doc with version and recent crawledAt.
	recentTime := time.Now().Add(-2 * 24 * time.Hour).Format(time.RFC3339)
	doc := &store.DocRow{
		URL:         "https://example.com/versioned",
		SectionPath: "Versioned Doc",
		Content:     "Versioned document with freshness metadata",
		SourceType:  "docs",
		Version:     "1.2.3",
		CrawledAt:   recentTime,
	}
	doc.ContentHash = store.ContentHashOf(doc.Content)
	if _, _, err := st.UpsertDoc(doc); err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"query": "versioned freshness",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m := resultJSON(t, res)
	results, ok := m["results"].([]any)
	if !ok || len(results) == 0 {
		t.Fatal("expected at least one result")
	}
	first := results[0].(map[string]any)
	if first["version"] != "1.2.3" {
		t.Errorf("version = %v, want 1.2.3", first["version"])
	}
	if first["freshness_days"] == nil {
		t.Error("expected freshness_days for doc with CrawledAt")
	}
	// Recent doc: no staleness_warning expected.
	if m["staleness_warning"] != nil {
		t.Errorf("unexpected staleness_warning for recent doc")
	}
}

func TestKnowledgeHandler_StalenessWarning(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := docsSearchHandler(st, nil, nil)

	// Doc crawled 60 days ago (> 30 day threshold).
	oldTime := time.Now().Add(-60 * 24 * time.Hour).Format(time.RFC3339)
	doc := &store.DocRow{
		URL:         "https://example.com/stale",
		SectionPath: "Stale Doc",
		Content:     "This stale document triggers staleness warning",
		SourceType:  "docs",
		CrawledAt:   oldTime,
	}
	doc.ContentHash = store.ContentHashOf(doc.Content)
	if _, _, err := st.UpsertDoc(doc); err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"query": "stale staleness",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m := resultJSON(t, res)
	warning, _ := m["staleness_warning"].(string)
	if warning == "" {
		t.Error("expected staleness_warning for doc older than 30 days")
	}
}

func TestKnowledgeHandler_CrawledAtSQLiteFormat(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := docsSearchHandler(st, nil, nil)

	// Doc with SQLite datetime format (not RFC3339).
	doc := &store.DocRow{
		URL:         "https://example.com/sqliteformat",
		SectionPath: "SQLite Format",
		Content:     "Document with sqlite datetime format crawled timestamp",
		SourceType:  "docs",
		CrawledAt:   "2020-01-01 00:00:00", // old enough for staleness warning
	}
	doc.ContentHash = store.ContentHashOf(doc.Content)
	if _, _, err := st.UpsertDoc(doc); err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"query": "sqlite datetime format",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m := resultJSON(t, res)
	results, ok := m["results"].([]any)
	if !ok || len(results) == 0 {
		t.Fatal("expected at least one result")
	}
	first := results[0].(map[string]any)
	if first["freshness_days"] == nil {
		t.Error("expected freshness_days even with SQLite datetime format")
	}
	if m["staleness_warning"] == nil {
		t.Error("expected staleness_warning for very old doc")
	}
}

func TestKnowledgeHandler_NoVersionOmitted(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := docsSearchHandler(st, nil, nil)

	doc := &store.DocRow{
		URL:         "https://example.com/noversion",
		SectionPath: "No Version",
		Content:     "Document without version field should omit it",
		SourceType:  "docs",
	}
	doc.ContentHash = store.ContentHashOf(doc.Content)
	if _, _, err := st.UpsertDoc(doc); err != nil {
		t.Fatalf("UpsertDoc: %v", err)
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"query": "without version",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m := resultJSON(t, res)
	results, ok := m["results"].([]any)
	if !ok || len(results) == 0 {
		t.Fatal("expected at least one result")
	}
	first := results[0].(map[string]any)
	if _, exists := first["version"]; exists {
		t.Error("version should be omitted when empty")
	}
}
