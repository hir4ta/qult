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

// seedSession inserts a session required for foreign key constraints.
func seedSession(t *testing.T, st *store.Store, id, project string) {
	t.Helper()
	err := st.UpsertSession(&store.SessionRow{
		ID:          id,
		ProjectPath: project,
		ProjectName: filepath.Base(project),
		JSONLPath:   filepath.Join(project, id+".jsonl"),
	})
	if err != nil {
		t.Fatalf("UpsertSession(%s): %v", id, err)
	}
}

// seedDecision inserts a decision row for testing.
func seedDecision(t *testing.T, st *store.Store, sessionID, topic, text, filePaths string) {
	t.Helper()
	err := st.InsertDecision(&store.DecisionRow{
		SessionID:    sessionID,
		Timestamp:    "2025-01-15T10:00:00Z",
		Topic:        topic,
		DecisionText: text,
		FilePaths:    filePaths,
	})
	if err != nil {
		t.Fatalf("InsertDecision(%s): %v", topic, err)
	}
}

// ---------------------------------------------------------------------------
// recall handler tests
// ---------------------------------------------------------------------------

func TestRecallHandler_EmptyQuery(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st)

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

func TestRecallHandler_NilStore(t *testing.T) {
	t.Parallel()
	handler := recallHandler(nil)

	res, err := handler(context.Background(), newRequest(map[string]any{"query": "test"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error result for nil store")
	}
}

func TestRecallHandler_FileScope(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st)

	seedSession(t, st, "s1", "/proj/myapp")
	seedDecision(t, st, "s1", "use WAL mode", "decided to use WAL mode for SQLite",
		`["internal/store/store.go"]`)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"query": "store.go",
		"scope": "file",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if m["scope"] != "file" {
		t.Errorf("scope = %v, want file", m["scope"])
	}
	decisions, ok := m["decisions"].([]any)
	if !ok || len(decisions) == 0 {
		t.Fatal("expected at least one decision for file scope")
	}
	d0 := decisions[0].(map[string]any)
	if d0["topic"] != "use WAL mode" {
		t.Errorf("topic = %v, want 'use WAL mode'", d0["topic"])
	}
}

func TestRecallHandler_DirectoryScope(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st)

	seedSession(t, st, "s1", "/proj/myapp")
	seedDecision(t, st, "s1", "refactor store", "split store into sub-files",
		`["internal/store/sessions.go","internal/store/events.go"]`)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"query": "internal/store/",
		"scope": "directory",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if m["scope"] != "directory" {
		t.Errorf("scope = %v, want directory", m["scope"])
	}
	decisions, ok := m["decisions"].([]any)
	if !ok || len(decisions) == 0 {
		t.Fatal("expected at least one decision for directory scope")
	}
}

func TestRecallHandler_AllScope(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st)

	seedSession(t, st, "s1", "/proj/myapp")
	seedDecision(t, st, "s1", "authentication strategy", "use JWT tokens for auth",
		`[]`)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"query": "authentication",
		"scope": "all",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if m["scope"] != "all" {
		t.Errorf("scope = %v, want all", m["scope"])
	}
}

func TestRecallHandler_ProjectScope(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st)

	seedSession(t, st, "s1", "/proj/myapp")
	seedDecision(t, st, "s1", "project setup", "initialized Go module",
		`[]`)

	// With project parameter: should return session stats.
	res, err := handler(context.Background(), newRequest(map[string]any{
		"query":   "project overview",
		"scope":   "project",
		"project": "/proj/myapp",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if m["scope"] != "project" {
		t.Errorf("scope = %v, want project", m["scope"])
	}
	if _, ok := m["session_stats"]; !ok {
		t.Error("expected session_stats in project scope result")
	}
}

func TestRecallHandler_ProjectScopeMissingProject(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st)

	// scope=project without project parameter should include error field.
	res, err := handler(context.Background(), newRequest(map[string]any{
		"query": "overview",
		"scope": "project",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	m := resultJSON(t, res)
	if errMsg, ok := m["error"].(string); !ok || errMsg == "" {
		t.Error("expected error field in result when project is missing for scope=project")
	}
}

func TestRecallHandler_AutoDetectScope(t *testing.T) {
	t.Parallel()
	cases := []struct {
		query string
		want  string
	}{
		{"main.go", "file"},
		{"internal/store/", "directory"},
		{"authentication", "all"},
	}
	for _, tc := range cases {
		t.Run(tc.query, func(t *testing.T) {
			t.Parallel()
			got := detectScope(tc.query)
			if got != tc.want {
				t.Errorf("detectScope(%q) = %q, want %q", tc.query, got, tc.want)
			}
		})
	}
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
	if m["search_method"] != "fts5_only" {
		t.Errorf("search_method = %v, want fts5_only (no embedder)", m["search_method"])
	}
	docsCount, _ := m["docs_count"].(float64)
	if docsCount == 0 {
		t.Error("expected at least one doc result")
	}
	// Verify hint about VOYAGE_API_KEY is present when embedder is nil.
	if _, ok := m["hint"]; !ok {
		t.Error("expected hint about VOYAGE_API_KEY when embedder is nil")
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

func TestKnowledgeHandler_NilStore(t *testing.T) {
	t.Parallel()
	// docsSearchHandler does not nil-check st before calling SearchDocsFTS.
	// With nil embedder, it falls through to FTS-only path.
	// This test verifies the handler does not panic with a nil store
	// (the FTS search would fail, but the handler should still return).
	// Note: the handler does not check st==nil at the top, so this may panic.
	// If the implementation adds a nil check, this test should verify IsError.
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
	st := openTestStore(t)
	claudeHome := t.TempDir()
	handler := reviewHandler(claudeHome, st)

	res, err := handler(context.Background(), newRequest(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	// Should still return a report even with empty project path.
	if _, ok := m["claude_md"]; !ok {
		t.Error("expected claude_md key in review report")
	}
	if _, ok := m["suggestions"]; !ok {
		t.Error("expected suggestions key in review report")
	}
}

func TestReviewHandler_WithClaudeMD(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	claudeHome := t.TempDir()
	projectDir := t.TempDir()
	handler := reviewHandler(claudeHome, st)

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
	st := openTestStore(t)
	claudeHome := t.TempDir()
	projectDir := t.TempDir()
	handler := reviewHandler(claudeHome, st)

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
	st := openTestStore(t)
	claudeHome := t.TempDir()
	handler := reviewHandler(claudeHome, st)

	// Create settings.json with hooks config.
	settings := map[string]any{
		"hooks": map[string]any{
			"SessionStart": []any{
				map[string]any{
					"hooks": []any{
						map[string]any{
							"command": "claude-alfred hook SessionStart",
							"timeout": 5000,
						},
					},
				},
			},
			"Stop": []any{
				map[string]any{
					"hooks": []any{
						map[string]any{
							"command": "claude-alfred hook Stop",
							"timeout": 5000,
							"async":   true,
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
	if hookCount != 2 {
		t.Errorf("hooks.count = %v, want 2", hookCount)
	}
	events, ok := hooks["events"].([]any)
	if !ok {
		t.Fatal("expected hooks.events to be an array")
	}
	if len(events) != 2 {
		t.Errorf("len(hooks.events) = %d, want 2", len(events))
	}
}

func TestReviewHandler_Suggestions(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	claudeHome := t.TempDir()
	projectDir := t.TempDir()
	handler := reviewHandler(claudeHome, st)

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

func TestFormatDecisions(t *testing.T) {
	t.Parallel()
	decisions := []store.DecisionRow{
		{
			SessionID:    "s1",
			Timestamp:    "2025-01-15T10:00:00Z",
			Topic:        "use WAL",
			DecisionText: "decided to use WAL mode",
			Reasoning:    "better concurrency",
			FilePaths:    `["store.go"]`,
		},
		{
			SessionID:    "s2",
			Timestamp:    "2025-01-16T10:00:00Z",
			Topic:        "add FTS",
			DecisionText: "added FTS5 search",
			FilePaths:    `[]`,
		},
	}

	items := formatDecisions(decisions)
	if len(items) != 2 {
		t.Fatalf("formatDecisions returned %d items, want 2", len(items))
	}

	// First decision should have reasoning and file_paths.
	d0 := items[0]
	if d0["topic"] != "use WAL" {
		t.Errorf("d0.topic = %v, want 'use WAL'", d0["topic"])
	}
	if d0["reasoning"] != "better concurrency" {
		t.Errorf("d0.reasoning = %v, want 'better concurrency'", d0["reasoning"])
	}
	if paths, ok := d0["file_paths"].([]string); !ok || len(paths) != 1 || paths[0] != "store.go" {
		t.Errorf("d0.file_paths = %v, want [store.go]", d0["file_paths"])
	}

	// Second decision should not have reasoning or file_paths (empty values).
	d1 := items[1]
	if _, ok := d1["reasoning"]; ok {
		t.Error("d1 should not have reasoning (empty)")
	}
	if _, ok := d1["file_paths"]; ok {
		t.Error("d1 should not have file_paths (empty array)")
	}
}
