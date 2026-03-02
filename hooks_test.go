package main

import (
	"testing"
)

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
