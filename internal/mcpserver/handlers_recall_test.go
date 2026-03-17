package mcpserver

import (
	"context"
	"strings"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// ---------------------------------------------------------------------------
// recall search tests
// ---------------------------------------------------------------------------

func TestRecallHandler_SearchEmpty(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"action": "search",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error result for empty query")
	}
	text := resultText(t, res)
	if !strings.Contains(text, "query") {
		t.Errorf("error message should mention query: %s", text)
	}
}

func TestRecallHandler_SearchNoResults(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"action": "search",
		"query":  "xyznonexistentterm",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	count, _ := m["count"].(float64)
	if count != 0 {
		t.Errorf("count = %v, want 0", count)
	}
}

func TestRecallHandler_SearchWithResults(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	// Seed a memory entry.
	doc := &store.KnowledgeRow{
		FilePath:    "memory://user/myproject/manual/2025-01-15T120000",
		Title:       "myproject > manual > OAuth implementation notes",
		Content:     "We decided to use PKCE flow for the OAuth2 implementation.",
		SubType:     "general",
	}
	doc.ContentHash = store.ContentHash(doc.Content)
	if _, _, err := st.UpsertKnowledge(context.Background(), doc); err != nil {
		t.Fatalf("UpsertKnowledge: %v", err)
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"action": "search",
		"query":  "OAuth implementation",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	count, _ := m["count"].(float64)
	if count < 1 {
		t.Errorf("count = %v, want >= 1", count)
	}
	method, _ := m["search_method"].(string)
	if method == "" {
		t.Error("expected search_method to be set")
	}
}

func TestRecallHandler_SearchLimitCapped(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	// Seed a memory entry so the search succeeds.
	doc := &store.KnowledgeRow{
		FilePath:    "memory://user/test/manual/2025-01-01T100000",
		Title:       "test > manual > note",
		Content:     "Test memory content for limit cap verification.",
		SubType:     "general",
	}
	doc.ContentHash = store.ContentHash(doc.Content)
	st.UpsertKnowledge(context.Background(), doc)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"action": "search",
		"query":  "test memory",
		"limit":  200,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	m := resultJSON(t, res)
	if warning, ok := m["warning"].(string); !ok || !strings.Contains(warning, "capped") {
		t.Errorf("expected warning about limit cap, got: %v", m["warning"])
	}
}

func TestRecallHandler_DefaultActionIsSearch(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	// No action specified — should default to search and require query.
	res, err := handler(context.Background(), newRequest(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error result for missing query (default search action)")
	}
}

// ---------------------------------------------------------------------------
// recall save tests
// ---------------------------------------------------------------------------

func TestRecallHandler_SaveSuccess(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"action":  "save",
		"content": "Always use table-driven tests in Go.",
		"label":   "Go testing best practice",
		"project": "my-project",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	status, _ := m["status"].(string)
	if status != "saved" {
		t.Errorf("status = %q, want saved", status)
	}
	id, _ := m["id"].(float64)
	if id == 0 {
		t.Error("expected non-zero id")
	}
	fp, _ := m["file_path"].(string)
	if fp == "" {
		t.Error("expected non-empty file_path")
	}
	title, _ := m["title"].(string)
	if !strings.Contains(title, "Go testing best practice") {
		t.Errorf("title = %q, should contain label", title)
	}
}

func TestRecallHandler_SaveMissingContent(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"action": "save",
		"label":  "some label",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error result for missing content")
	}
	text := resultText(t, res)
	if !strings.Contains(text, "content") {
		t.Errorf("error should mention content: %s", text)
	}
}

func TestRecallHandler_SaveMissingLabel(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"action":  "save",
		"content": "some content",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error result for missing label")
	}
	text := resultText(t, res)
	if !strings.Contains(text, "label") {
		t.Errorf("error should mention label: %s", text)
	}
}

func TestRecallHandler_SaveDefaultProject(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"action":  "save",
		"content": "A general note.",
		"label":   "general note",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	fp, _ := m["file_path"].(string)
	if fp == "" {
		t.Error("expected non-empty file_path for default project")
	}
}

func TestRecallHandler_SaveInvalidProject(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"action":  "save",
		"content": "some content",
		"label":   "test",
		"project": "../evil-path",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error result for invalid project name")
	}
	text := resultText(t, res)
	if !strings.Contains(text, "invalid") {
		t.Errorf("error should mention invalid: %s", text)
	}
}

func TestRecallHandler_SaveDuplicate(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	args := map[string]any{
		"action":  "save",
		"content": "Exactly the same content.",
		"label":   "duplicate test",
		"project": "test-proj",
	}

	// First save.
	res1, err := handler(context.Background(), newRequest(args))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m1 := resultJSON(t, res1)
	if m1["status"] != "saved" {
		t.Fatalf("first save status = %v, want saved", m1["status"])
	}

	// Second save with same content — UpsertDoc detects no change.
	// Note: URL includes timestamp so it will be a different URL,
	// meaning UpsertDoc treats it as a new doc. This is expected behavior
	// with the second-precision timestamps.
	res2, err := handler(context.Background(), newRequest(args))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res2.IsError {
		t.Fatalf("unexpected error: %s", resultText(t, res2))
	}
}

// ---------------------------------------------------------------------------
// recall unknown action
// ---------------------------------------------------------------------------

func TestRecallHandler_UnknownAction(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"action": "delete",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error result for unknown action")
	}
	text := resultText(t, res)
	if !strings.Contains(text, "delete") {
		t.Errorf("error should echo the bad action: %s", text)
	}
}

// ---------------------------------------------------------------------------
// recall search + save round-trip
// ---------------------------------------------------------------------------

func TestRecallHandler_SaveThenSearch(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	// Save a memory.
	saveRes, err := handler(context.Background(), newRequest(map[string]any{
		"action":  "save",
		"content": "The deployment pipeline uses Terraform for infrastructure provisioning.",
		"label":   "deployment pipeline notes",
		"project": "infra",
	}))
	if err != nil {
		t.Fatalf("save error: %v", err)
	}
	if saveRes.IsError {
		t.Fatalf("save failed: %s", resultText(t, saveRes))
	}

	// Search for it.
	searchRes, err := handler(context.Background(), newRequest(map[string]any{
		"action": "search",
		"query":  "Terraform deployment pipeline",
	}))
	if err != nil {
		t.Fatalf("search error: %v", err)
	}
	if searchRes.IsError {
		t.Fatalf("search failed: %s", resultText(t, searchRes))
	}

	m := resultJSON(t, searchRes)
	count, _ := m["count"].(float64)
	if count < 1 {
		t.Error("expected to find the saved memory via search")
	}

	results, ok := m["results"].([]any)
	if !ok || len(results) == 0 {
		t.Fatal("expected results array with entries")
	}
	first := results[0].(map[string]any)
	content, _ := first["content"].(string)
	if !strings.Contains(content, "Terraform") {
		t.Errorf("content = %q, expected to contain Terraform", content)
	}
}
