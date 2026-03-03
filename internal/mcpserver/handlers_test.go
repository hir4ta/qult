package mcpserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// openTestStore creates a temporary SQLite store for testing.
func openTestStore(t *testing.T) *store.Store {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// newRequest builds a CallToolRequest with the given arguments.
func newRequest(args map[string]any) mcp.CallToolRequest {
	var req mcp.CallToolRequest
	req.Params.Arguments = args
	return req
}

// resultText extracts the text string from a CallToolResult.
func resultText(t *testing.T, res *mcp.CallToolResult) string {
	t.Helper()
	if len(res.Content) == 0 {
		t.Fatal("result has no content")
	}
	tc, ok := res.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("result content is not TextContent: %T", res.Content[0])
	}
	return tc.Text
}

// resultJSON extracts the JSON body from a CallToolResult into a map.
func resultJSON(t *testing.T, res *mcp.CallToolResult) map[string]any {
	t.Helper()
	text := resultText(t, res)
	var m map[string]any
	if err := json.Unmarshal([]byte(text), &m); err != nil {
		t.Fatalf("unmarshal result JSON: %v\nraw: %s", err, text)
	}
	return m
}

// ---------------------------------------------------------------------------
// knowledge / docs search handler tests
// ---------------------------------------------------------------------------

func TestKnowledgeHandler_EmptyQuery(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := docsSearchHandler(st, nil)

	res, err := handler(context.Background(), newRequest(nil))
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

func TestKnowledgeHandler_FTSSearch(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := docsSearchHandler(st, nil)

	// Insert docs into the store.
	for _, doc := range []store.DocRow{
		{URL: "https://docs.example.com/hooks", SectionPath: "Hooks > Overview",
			Content: "Hooks allow you to run commands on lifecycle events.", SourceType: "docs"},
		{URL: "https://docs.example.com/skills", SectionPath: "Skills > Overview",
			Content: "Skills are prompt templates that guide Claude.", SourceType: "docs"},
	} {
		doc.ContentHash = store.ContentHashOf(doc.Content)
		if _, _, err := st.UpsertDoc(&doc); err != nil {
			t.Fatalf("UpsertDoc: %v", err)
		}
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"query": "hooks lifecycle",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	docsCount, _ := m["docs_count"].(float64)
	if docsCount == 0 {
		t.Error("expected at least one doc result")
	}
}

func TestKnowledgeHandler_NoResults(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := docsSearchHandler(st, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"query": "xyznonexistentterm",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	docsCount, _ := m["docs_count"].(float64)
	if docsCount != 0 {
		t.Errorf("docs_count = %v, want 0 for no matching docs", docsCount)
	}
}

// ---------------------------------------------------------------------------
// ingest handler tests
// ---------------------------------------------------------------------------

func TestIngestHandler_NewDoc(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := ingestHandler(st, nil)

	sections := []map[string]any{
		{"path": "Getting Started > Install", "content": "Run npm install to get started."},
		{"path": "Getting Started > Config", "content": "Create a config file."},
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"url":      "https://docs.example.com/start",
		"sections": sections,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if m["url"] != "https://docs.example.com/start" {
		t.Errorf("url = %v, want https://docs.example.com/start", m["url"])
	}
	ingested, _ := m["ingested"].(float64)
	if ingested != 2 {
		t.Errorf("ingested = %v, want 2", ingested)
	}
	unchanged, _ := m["unchanged"].(float64)
	if unchanged != 0 {
		t.Errorf("unchanged = %v, want 0", unchanged)
	}
}

func TestIngestHandler_UpdateDoc(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := ingestHandler(st, nil)

	sections := []map[string]any{
		{"path": "Overview", "content": "Original content."},
	}

	// First ingest.
	res, err := handler(context.Background(), newRequest(map[string]any{
		"url":      "https://docs.example.com/overview",
		"sections": sections,
	}))
	if err != nil {
		t.Fatalf("first ingest error: %v", err)
	}
	if res.IsError {
		t.Fatalf("first ingest error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	ingested, _ := m["ingested"].(float64)
	if ingested != 1 {
		t.Errorf("first ingest: ingested = %v, want 1", ingested)
	}

	// Second ingest with same content: should be unchanged.
	res, err = handler(context.Background(), newRequest(map[string]any{
		"url":      "https://docs.example.com/overview",
		"sections": sections,
	}))
	if err != nil {
		t.Fatalf("second ingest error: %v", err)
	}
	if res.IsError {
		t.Fatalf("second ingest error result: %s", resultText(t, res))
	}

	m = resultJSON(t, res)
	unchanged, _ := m["unchanged"].(float64)
	if unchanged != 1 {
		t.Errorf("second ingest: unchanged = %v, want 1", unchanged)
	}

	// Third ingest with different content: should be updated.
	updatedSections := []map[string]any{
		{"path": "Overview", "content": "Updated content with new information."},
	}
	res, err = handler(context.Background(), newRequest(map[string]any{
		"url":      "https://docs.example.com/overview",
		"sections": updatedSections,
	}))
	if err != nil {
		t.Fatalf("third ingest error: %v", err)
	}
	if res.IsError {
		t.Fatalf("third ingest error result: %s", resultText(t, res))
	}

	m = resultJSON(t, res)
	ingested, _ = m["ingested"].(float64)
	if ingested != 1 {
		t.Errorf("third ingest: ingested = %v, want 1 (updated)", ingested)
	}
}

func TestIngestHandler_MissingURL(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := ingestHandler(st, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"sections": []map[string]any{
			{"path": "A", "content": "B"},
		},
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error result for missing URL")
	}
	text := resultText(t, res)
	if !strings.Contains(text, "url") {
		t.Errorf("error message should mention url: %s", text)
	}
}

func TestIngestHandler_MissingSections(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := ingestHandler(st, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"url": "https://docs.example.com/test",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error result for missing sections")
	}
	text := resultText(t, res)
	if !strings.Contains(text, "sections") {
		t.Errorf("error message should mention sections: %s", text)
	}
}

func TestIngestHandler_EmptySections(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := ingestHandler(st, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"url":      "https://docs.example.com/test",
		"sections": []map[string]any{},
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error result for empty sections array")
	}
}

func TestIngestHandler_NilStore(t *testing.T) {
	t.Parallel()
	handler := ingestHandler(nil, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"url":      "https://docs.example.com/test",
		"sections": []map[string]any{{"path": "A", "content": "B"}},
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error result for nil store")
	}
}

func TestIngestHandler_SourceTypeAndVersion(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := ingestHandler(st, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"url":         "https://docs.example.com/changelog",
		"sections":    []map[string]any{{"path": "v1.0.30", "content": "New hook events."}},
		"source_type": "changelog",
		"version":     "1.0.30",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if m["source_type"] != "changelog" {
		t.Errorf("source_type = %v, want changelog", m["source_type"])
	}
}

// ---------------------------------------------------------------------------
// review handler tests
// ---------------------------------------------------------------------------

func TestReviewHandler_EmptyProject(t *testing.T) {
	t.Parallel()
	claudeHome := t.TempDir()
	handler := reviewHandler(claudeHome)

	res, err := handler(context.Background(), newRequest(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if _, ok := m["claude_md"]; !ok {
		t.Error("expected claude_md key in review report")
	}
	if _, ok := m["suggestions"]; !ok {
		t.Error("expected suggestions key in review report")
	}
}

func TestReviewHandler_WithClaudeMD(t *testing.T) {
	t.Parallel()
	claudeHome := t.TempDir()
	projectDir := t.TempDir()
	handler := reviewHandler(claudeHome)

	// Create a CLAUDE.md file in the project directory.
	claudeMD := `# My Project

## Commands

` + "```" + `bash
go build ./...
go test ./...
` + "```" + `

## Stack

Go 1.22 / PostgreSQL

## Structure

| Package | Role |
|---|---|
| cmd/ | Entry points |
| internal/ | Business logic |

## Rules

- Always run tests before committing
`

	err := os.WriteFile(filepath.Join(projectDir, "CLAUDE.md"), []byte(claudeMD), 0o644)
	if err != nil {
		t.Fatalf("write CLAUDE.md: %v", err)
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": projectDir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	claudeResult, ok := m["claude_md"].(map[string]any)
	if !ok {
		t.Fatal("expected claude_md to be a map")
	}
	if exists, _ := claudeResult["exists"].(bool); !exists {
		t.Error("expected claude_md.exists = true")
	}
	if sections, ok := claudeResult["sections"].([]any); !ok || len(sections) == 0 {
		t.Error("expected non-empty sections list in claude_md")
	}
	keySections, ok := claudeResult["key_sections"].(map[string]any)
	if !ok {
		t.Fatal("expected key_sections to be a map")
	}
	if cmd, _ := keySections["commands"].(bool); !cmd {
		t.Error("expected key_sections.commands = true")
	}
	if stack, _ := keySections["stack"].(bool); !stack {
		t.Error("expected key_sections.stack = true")
	}
}

func TestReviewHandler_WithSkillsAndRules(t *testing.T) {
	t.Parallel()
	claudeHome := t.TempDir()
	projectDir := t.TempDir()
	handler := reviewHandler(claudeHome)

	// Create .claude/skills/mypkg/SKILL.md
	skillDir := filepath.Join(projectDir, ".claude", "skills", "mypkg")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatalf("mkdir skills: %v", err)
	}
	skillContent := `---
name: my-skill
description: A test skill
---
# My Skill
`
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(skillContent), 0o644); err != nil {
		t.Fatalf("write SKILL.md: %v", err)
	}

	// Create .claude/rules/myrule.md
	rulesDir := filepath.Join(projectDir, ".claude", "rules")
	if err := os.MkdirAll(rulesDir, 0o755); err != nil {
		t.Fatalf("mkdir rules: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rulesDir, "myrule.md"), []byte("# Rule"), 0o644); err != nil {
		t.Fatalf("write rule: %v", err)
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": projectDir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)

	skills, ok := m["skills"].(map[string]any)
	if !ok {
		t.Fatal("expected skills to be a map")
	}
	skillCount, _ := skills["count"].(float64)
	if skillCount < 1 {
		t.Errorf("skills.count = %v, want >= 1", skillCount)
	}

	rules, ok := m["rules"].(map[string]any)
	if !ok {
		t.Fatal("expected rules to be a map")
	}
	ruleCount, _ := rules["count"].(float64)
	if ruleCount < 1 {
		t.Errorf("rules.count = %v, want >= 1", ruleCount)
	}
}

func TestReviewHandler_WithHooks(t *testing.T) {
	t.Parallel()
	claudeHome := t.TempDir()
	handler := reviewHandler(claudeHome)

	// Create settings.json with hooks config.
	settings := map[string]any{
		"hooks": map[string]any{
			"SessionStart": []any{
				map[string]any{
					"hooks": []any{
						map[string]any{
							"command": "alfred hook SessionStart",
							"timeout": 5000,
						},
					},
				},
			},
		},
	}
	data, _ := json.Marshal(settings)
	if err := os.WriteFile(filepath.Join(claudeHome, "settings.json"), data, 0o644); err != nil {
		t.Fatalf("write settings.json: %v", err)
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": t.TempDir(),
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	hooks, ok := m["hooks"].(map[string]any)
	if !ok {
		t.Fatal("expected hooks to be a map")
	}
	hookCount, _ := hooks["count"].(float64)
	if hookCount != 1 {
		t.Errorf("hooks.count = %v, want 1", hookCount)
	}
}

func TestReviewHandler_Suggestions(t *testing.T) {
	t.Parallel()
	claudeHome := t.TempDir()
	projectDir := t.TempDir()
	handler := reviewHandler(claudeHome)

	// Empty project directory: should generate suggestions.
	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": projectDir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	m := resultJSON(t, res)
	suggestions, ok := m["suggestions"].([]any)
	if !ok {
		t.Fatal("expected suggestions to be an array")
	}
	if len(suggestions) == 0 {
		t.Error("expected at least one suggestion for empty project")
	}

	// Verify suggestion about CLAUDE.md is present.
	found := false
	for _, s := range suggestions {
		if str, ok := s.(string); ok && strings.Contains(str, "CLAUDE.md") {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected a suggestion about creating CLAUDE.md")
	}
}

// ---------------------------------------------------------------------------
// helper tests
// ---------------------------------------------------------------------------

func TestMarshalResult(t *testing.T) {
	t.Parallel()
	input := map[string]any{
		"key":   "value",
		"count": 42,
	}

	res, err := marshalResult(input)
	if err != nil {
		t.Fatalf("marshalResult error: %v", err)
	}
	if res.IsError {
		t.Fatal("marshalResult returned error result")
	}

	m := resultJSON(t, res)
	if m["key"] != "value" {
		t.Errorf("key = %v, want value", m["key"])
	}
	count, _ := m["count"].(float64)
	if count != 42 {
		t.Errorf("count = %v, want 42", count)
	}
}

func TestTruncate(t *testing.T) {
	t.Parallel()
	cases := []struct {
		input  string
		maxLen int
		want   string
	}{
		{"short", 10, "short"},
		{"exactly10!", 10, "exactly10!"},
		{"this is longer than ten", 10, "this is lo..."},
		{"", 5, ""},
		{"abc", 3, "abc"},
		{"abcd", 3, "abc..."},
	}
	for _, tc := range cases {
		got := truncate(tc.input, tc.maxLen)
		if got != tc.want {
			t.Errorf("truncate(%q, %d) = %q, want %q", tc.input, tc.maxLen, got, tc.want)
		}
	}
}
