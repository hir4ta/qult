package main

import (
	"testing"
)

func TestShouldRemind(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		input map[string]any
		want  bool
	}{
		{"nil input", nil, false},
		{"empty input", map[string]any{}, false},
		{"unrelated path", map[string]any{"file_path": "/src/main.go"}, false},
		{".claude/ in file_path", map[string]any{"file_path": "/project/.claude/rules/foo.md"}, true},
		{"CLAUDE.md in file_path", map[string]any{"file_path": "/project/CLAUDE.md"}, true},
		{"MEMORY.md in path", map[string]any{"path": "/project/MEMORY.md"}, true},
		{".mcp.json in file_path", map[string]any{"file_path": "/project/.mcp.json"}, true},
		{".claude/ in pattern", map[string]any{"pattern": "**/.claude/**"}, true},
		{"non-string value", map[string]any{"file_path": 123}, false},
		{"empty string", map[string]any{"file_path": ""}, false},
		{"case insensitive", map[string]any{"file_path": "/project/.Claude/rules/x.md"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := shouldRemind(tt.input); got != tt.want {
				t.Errorf("shouldRemind(%v) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestShouldRemindPrompt(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		prompt string
		want   bool
	}{
		{"empty", "", false},
		{"unrelated", "Fix the login bug", false},
		{".claude mention", ".claude/agents をレビューして", true},
		{"CLAUDE.md mention", "CLAUDE.md を改善して", true},
		{"MEMORY.md mention", "MEMORY.md を確認して", true},
		{".mcp.json mention", ".mcp.json を更新して", true},
		{"case insensitive", "claude.md を見て", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := shouldRemindPrompt(tt.prompt); got != tt.want {
				t.Errorf("shouldRemindPrompt(%q) = %v, want %v", tt.prompt, got, tt.want)
			}
		})
	}
}

func TestIsClaudeConfigPath(t *testing.T) {
	t.Parallel()
	tests := []struct {
		path string
		want bool
	}{
		{"/project/.claude/hooks/hooks.json", true},
		{"/project/.claude/skills/setup/SKILL.md", true},
		{"/project/.claude/agents/alfred.md", true},
		{"/project/.claude/memory/notes.md", true},
		{"/project/CLAUDE.md", true},
		{"/project/MEMORY.md", true},
		{"/project/.mcp.json", true},
		{"/project/src/main.go", false},
		{"/project/README.md", false},
		{"", false},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			t.Parallel()
			if got := isClaudeConfigPath(tt.path); got != tt.want {
				t.Errorf("isClaudeConfigPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestSplitMarkdownSections(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantLen  int
		wantPath []string
	}{
		{
			name:    "empty",
			input:   "",
			wantLen: 0,
		},
		{
			name:    "no headers",
			input:   "just some text\nno headers here",
			wantLen: 0,
		},
		{
			name:     "single h1 root",
			input:    "# Title\nsome content here\nmore content",
			wantLen:  1,
			wantPath: []string{"Title"},
		},
		{
			name:     "multiple h2 sections",
			input:    "# Root\n\n## Commands\nbuild stuff\n\n## Rules\nfollow rules\n",
			wantLen:  2,
			wantPath: []string{"Commands", "Rules"},
		},
		{
			name:     "h2 sections without h1",
			input:    "## Stack\nGo 1.25\n\n## Structure\ntable here\n",
			wantLen:  2,
			wantPath: []string{"Stack", "Structure"},
		},
		{
			name:     "h1 followed by h2 overrides root path",
			input:    "# Intro\n\n## Section A\ncontent A\n\n## Section B\ncontent B\n",
			wantLen:  2,
			wantPath: []string{"Section A", "Section B"},
		},
		{
			name:     "empty section body is skipped",
			input:    "## Empty\n\n## HasContent\nactual text\n",
			wantLen:  1,
			wantPath: []string{"HasContent"},
		},
		{
			name:     "whitespace-only section body is skipped",
			input:    "## Blank\n   \n\n## Real\ncontent\n",
			wantLen:  1,
			wantPath: []string{"Real"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := splitMarkdownSections(tt.input)
			if len(got) != tt.wantLen {
				t.Errorf("splitMarkdownSections() = %d sections, want %d (got %v)", len(got), tt.wantLen, got)
				return
			}
			for i, wantPath := range tt.wantPath {
				if i >= len(got) {
					break
				}
				if got[i].Path != wantPath {
					t.Errorf("section[%d].Path = %q, want %q", i, got[i].Path, wantPath)
				}
				if got[i].Content == "" {
					t.Errorf("section[%d].Content is empty", i)
				}
			}
		})
	}
}
