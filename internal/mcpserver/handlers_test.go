package mcpserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
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
// review handler tests
// ---------------------------------------------------------------------------

func TestReviewHandler_EmptyProject(t *testing.T) {
	t.Parallel()
	claudeHome := t.TempDir()
	handler := reviewHandler(claudeHome, nil, nil)

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
	handler := reviewHandler(claudeHome, nil, nil)

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
	handler := reviewHandler(claudeHome, nil, nil)

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
	handler := reviewHandler(claudeHome, nil, nil)

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

func TestReviewHandler_WithProjectHooks(t *testing.T) {
	t.Parallel()
	claudeHome := t.TempDir()
	projectDir := t.TempDir()
	handler := reviewHandler(claudeHome, nil, nil)

	// Create project-level .claude/hooks.json.
	hooksDir := filepath.Join(projectDir, ".claude")
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	hooksJSON := map[string]any{
		"hooks": map[string]any{
			"SessionStart": []any{},
			"PreToolUse":   []any{},
		},
	}
	data, _ := json.Marshal(hooksJSON)
	if err := os.WriteFile(filepath.Join(hooksDir, "hooks.json"), data, 0o644); err != nil {
		t.Fatalf("write hooks.json: %v", err)
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": projectDir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
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
	// Verify project_hooks path is reported.
	ph, _ := hooks["project_hooks"].(string)
	if ph == "" {
		t.Error("expected project_hooks path to be set")
	}
}

func TestReviewHandler_Suggestions(t *testing.T) {
	t.Parallel()
	claudeHome := t.TempDir()
	projectDir := t.TempDir()
	handler := reviewHandler(claudeHome, nil, nil)

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

	// Verify suggestion about CLAUDE.md is present (structured format).
	found := false
	for _, s := range suggestions {
		sm, ok := s.(map[string]any)
		if !ok {
			continue
		}
		if msg, _ := sm["message"].(string); strings.Contains(msg, "CLAUDE.md") {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected a suggestion about creating CLAUDE.md")
	}
}

// ---------------------------------------------------------------------------
// review: deep skill analysis
// ---------------------------------------------------------------------------

func TestReviewHandler_SkillBodyTooLong(t *testing.T) {
	t.Parallel()
	claudeHome := t.TempDir()
	projectDir := t.TempDir()
	handler := reviewHandler(claudeHome, nil, nil)

	skillDir := filepath.Join(projectDir, ".claude", "skills", "big-skill")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}

	var body strings.Builder
	body.WriteString("---\nname: big-skill\ndescription: test\n---\n")
	for i := range 200 {
		body.WriteString("Line " + strconv.Itoa(i) + " of instructions\n")
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(body.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": projectDir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	m := resultJSON(t, res)
	skills := m["skills"].(map[string]any)
	details := skills["skill_details"].([]any)
	detail := details[0].(map[string]any)

	if detail["size_warning"] == nil {
		t.Error("expected size_warning for skill with >150 lines body")
	}
	bodyLines, _ := detail["body_lines"].(float64)
	if bodyLines < 150 {
		t.Errorf("body_lines = %v, want > 150", bodyLines)
	}
}

func TestReviewHandler_SkillSupportFiles(t *testing.T) {
	t.Parallel()
	claudeHome := t.TempDir()
	projectDir := t.TempDir()
	handler := reviewHandler(claudeHome, nil, nil)

	skillDir := filepath.Join(projectDir, ".claude", "skills", "my-skill")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: my-skill\ndescription: test\n---\n# Skill\n"), 0o644)
	os.WriteFile(filepath.Join(skillDir, "template.md"), []byte("# Template"), 0o644)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": projectDir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	m := resultJSON(t, res)
	skills := m["skills"].(map[string]any)
	details := skills["skill_details"].([]any)
	detail := details[0].(map[string]any)

	if hasSupport, _ := detail["has_support_files"].(bool); !hasSupport {
		t.Error("expected has_support_files = true")
	}
}

// ---------------------------------------------------------------------------
// review: rules content analysis
// ---------------------------------------------------------------------------

func TestReviewHandler_RuleTooShort(t *testing.T) {
	t.Parallel()
	claudeHome := t.TempDir()
	projectDir := t.TempDir()
	handler := reviewHandler(claudeHome, nil, nil)

	rulesDir := filepath.Join(projectDir, ".claude", "rules")
	if err := os.MkdirAll(rulesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(rulesDir, "empty.md"), []byte("# Rule\n"), 0o644)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": projectDir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	m := resultJSON(t, res)
	rules := m["rules"].(map[string]any)
	details, ok := rules["rule_details"].([]any)
	if !ok || len(details) == 0 {
		t.Fatal("expected rule_details")
	}
	detail := details[0].(map[string]any)
	if detail["size_warning"] == nil {
		t.Error("expected size_warning for rule with < 3 lines")
	}
}

// ---------------------------------------------------------------------------
// review: KB enrichment
// ---------------------------------------------------------------------------

func TestReviewHandler_WithKBEnrichment(t *testing.T) {
	t.Parallel()
	claudeHome := t.TempDir()
	projectDir := t.TempDir()
	st := openTestStore(t)

	// Seed KB with a relevant doc.
	doc := &store.DocRow{
		URL:         "https://code.claude.com/docs/en/claude-md",
		SectionPath: "CLAUDE.md > Best Practices",
		Content:     "A good CLAUDE.md includes Commands, Stack, and Structure sections.",
		SourceType:  "docs",
	}
	doc.ContentHash = store.ContentHashOf(doc.Content)
	st.UpsertDoc(doc)

	handler := reviewHandler(claudeHome, st, nil)

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
	suggestions, ok := m["suggestions"].([]any)
	if !ok || len(suggestions) == 0 {
		t.Fatal("expected suggestions")
	}

	// At least one suggestion should have a best_practice from KB.
	hasBP := false
	for _, s := range suggestions {
		sm, ok := s.(map[string]any)
		if !ok {
			continue
		}
		if sm["best_practice"] != nil {
			hasBP = true
			break
		}
	}
	if !hasBP {
		t.Error("expected at least one suggestion with best_practice from KB")
	}
}

// ---------------------------------------------------------------------------
// review: structured suggestions
// ---------------------------------------------------------------------------

func TestReviewHandler_StructuredSuggestions(t *testing.T) {
	t.Parallel()
	claudeHome := t.TempDir()
	projectDir := t.TempDir()
	handler := reviewHandler(claudeHome, nil, nil)

	res, err := handler(context.Background(), newRequest(map[string]any{
		"project_path": projectDir,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	m := resultJSON(t, res)
	suggestions, ok := m["suggestions"].([]any)
	if !ok || len(suggestions) == 0 {
		t.Fatal("expected suggestions for empty project")
	}

	// Verify structured format.
	first := suggestions[0].(map[string]any)
	if first["severity"] == nil {
		t.Error("expected severity field")
	}
	if first["category"] == nil {
		t.Error("expected category field")
	}
	if first["message"] == nil {
		t.Error("expected message field")
	}
}

// ---------------------------------------------------------------------------
// queryKB tests
// ---------------------------------------------------------------------------

func TestQueryKB_NilStore(t *testing.T) {
	t.Parallel()
	result := queryKB(nil, "hooks", 3)
	if result != nil {
		t.Errorf("expected nil for nil store, got %v", result)
	}
}

func TestQueryKB_WithResults(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	doc := &store.DocRow{
		URL:         "https://example.com/hooks",
		SectionPath: "Hooks > Overview",
		Content:     "Hooks allow automation of Claude Code lifecycle events.",
		SourceType:  "docs",
	}
	doc.ContentHash = store.ContentHashOf(doc.Content)
	st.UpsertDoc(doc)

	snippets := queryKB(st, "hooks lifecycle", 3)
	if len(snippets) == 0 {
		t.Fatal("expected at least one snippet")
	}
	if snippets[0].SectionPath != "Hooks > Overview" {
		t.Errorf("section_path = %q, want Hooks > Overview", snippets[0].SectionPath)
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

func TestReviewDir_Agents(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	// Empty: no agents dir.
	result := reviewDir(dir, ".claude", "agents")
	if count, _ := result["count"].(int); count != 0 {
		t.Errorf("empty dir should have count 0, got %d", count)
	}

	// With an agent file.
	agentsDir := filepath.Join(dir, ".claude", "agents")
	os.MkdirAll(agentsDir, 0o755)
	os.WriteFile(filepath.Join(agentsDir, "butler.md"), []byte("# Butler"), 0o644)

	result = reviewDir(dir, ".claude", "agents")
	if count, _ := result["count"].(int); count != 1 {
		t.Errorf("agents count = %d, want 1", count)
	}
	items, _ := result["items"].([]string)
	if len(items) != 1 || items[0] != "butler.md" {
		t.Errorf("items = %v, want [butler.md]", items)
	}
}

func TestReviewDir_Empty(t *testing.T) {
	t.Parallel()
	result := reviewDir("", ".claude", "agents")
	if count, _ := result["count"].(int); count != 0 {
		t.Errorf("empty projectPath should have count 0")
	}
}

func TestReviewMCP(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	// No .mcp.json.
	result := reviewMCP(dir)
	if count, _ := result["count"].(int); count != 0 {
		t.Errorf("no mcp.json should have count 0")
	}

	// With .mcp.json.
	mcpJSON := `{"mcpServers":{"alfred":{"command":"alfred","args":["serve"]},"context7":{"command":"context7"}}}`
	os.WriteFile(filepath.Join(dir, ".mcp.json"), []byte(mcpJSON), 0o644)

	result = reviewMCP(dir)
	count, _ := result["count"].(int)
	if count != 2 {
		t.Errorf("mcp count = %d, want 2", count)
	}
	servers, _ := result["servers"].([]string)
	if len(servers) != 2 {
		t.Errorf("servers = %v, want 2 servers", servers)
	}
}

func TestReviewMCP_InvalidJSON(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".mcp.json"), []byte("not json"), 0o644)

	result := reviewMCP(dir)
	if count, _ := result["count"].(int); count != 0 {
		t.Errorf("invalid json should have count 0")
	}
}

func TestReviewMCP_Empty(t *testing.T) {
	t.Parallel()
	result := reviewMCP("")
	if count, _ := result["count"].(int); count != 0 {
		t.Errorf("empty path should have count 0")
	}
}

func TestCountBodyLines(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		content string
		want    int
	}{
		{"no frontmatter", "line1\nline2\n", 2},
		{"with frontmatter", "---\nname: test\n---\nBody line 1\nBody line 2\n", 2},
		{"empty body", "---\nname: test\n---\n", 0},
		{"no closing delimiter", "---\nname: test\nno close", 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := countBodyLines(tt.content)
			if got != tt.want {
				t.Errorf("countBodyLines() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestParseSKILLFrontmatter(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		content string
		wantKey string
		wantVal string
	}{
		{"with frontmatter", "---\nname: my-skill\ndescription: test skill\n---\n# Body\n", "name", "my-skill"},
		{"no frontmatter", "# Just markdown\ncontent\n", "name", ""},
		{"multiline value", "---\nname: test\ndescription: >\n  a long description\n---\n", "description", ""},
		{"no closing", "---\nname: test\nno close\n", "name", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			fm := parseSKILLFrontmatter(tt.content)
			if fm[tt.wantKey] != tt.wantVal {
				t.Errorf("fm[%q] = %q, want %q", tt.wantKey, fm[tt.wantKey], tt.wantVal)
			}
		})
	}
}
