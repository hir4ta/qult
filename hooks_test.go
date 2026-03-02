package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// openTestStore creates a temporary store for testing.
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

// ---------------------------------------------------------------------------
// promptText
// ---------------------------------------------------------------------------

func TestPromptText(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		json string
		want string
	}{
		{"object form", `{"message":"hello world"}`, "hello world"},
		{"string form", `"hello world"`, "hello world"},
		{"empty", ``, ""},
		{"null", `null`, ""},
		{"malformed", `{invalid`, ""},
		{"object no message", `{"other":"value"}`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := promptText([]byte(tc.json))
			if got != tc.want {
				t.Errorf("promptText(%s) = %q, want %q", tc.json, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// matchAlfredHint
// ---------------------------------------------------------------------------

func TestMatchAlfredHint(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		prompt  string
		wantHit bool
		wantSub string
	}{
		{"review + skill", "skillをレビューして", true, "review"},
		{"review + hook", "hookを分析したい", true, "review"},
		{"review + claude.md", "claude.mdのチェック", true, "review"},
		{"knowledge trigger", "ベストプラクティスを知りたい", true, "knowledge"},
		{"best practice EN", "best practice for hooks", true, "knowledge"},
		{"no match", "ファイルを修正して", false, ""},
		{"empty", "", false, ""},
		{"action only no subject", "レビューして", false, ""},
		{"subject only no action", "hookについて", false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := matchAlfredHint(tc.prompt)
			if tc.wantHit && got == "" {
				t.Errorf("matchAlfredHint(%q) = empty, want match containing %q", tc.prompt, tc.wantSub)
			}
			if !tc.wantHit && got != "" {
				t.Errorf("matchAlfredHint(%q) = %q, want empty", tc.prompt, got)
			}
			if tc.wantHit && tc.wantSub != "" && !strings.Contains(got, tc.wantSub) {
				t.Errorf("matchAlfredHint(%q) = %q, want substring %q", tc.prompt, got, tc.wantSub)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// containsAny
// ---------------------------------------------------------------------------

func TestContainsAny(t *testing.T) {
	t.Parallel()
	if !containsAny("hello world", []string{"world"}) {
		t.Error("expected true for matching word")
	}
	if containsAny("hello world", []string{"foo", "bar"}) {
		t.Error("expected false for non-matching words")
	}
	if containsAny("", []string{"a"}) {
		t.Error("expected false for empty string")
	}
}

// ---------------------------------------------------------------------------
// buildProjectContext
// ---------------------------------------------------------------------------

func TestBuildProjectContext(t *testing.T) {
	t.Parallel()

	t.Run("nil store returns empty", func(t *testing.T) {
		t.Parallel()
		got := buildProjectContext(nil, "fix internal/store/events.go")
		if got != "" {
			t.Errorf("expected empty, got %q", got)
		}
	})

	t.Run("no file paths returns empty", func(t *testing.T) {
		t.Parallel()
		st := openTestStore(t)
		got := buildProjectContext(st, "just a question without paths")
		if got != "" {
			t.Errorf("expected empty, got %q", got)
		}
	})

	t.Run("decisions injected", func(t *testing.T) {
		t.Parallel()
		st := openTestStore(t)

		st.DB().Exec(`INSERT INTO sessions (id, project_path, project_name, jsonl_path) VALUES ('s1', '/tmp', 'test', '/tmp/t.jsonl')`)
		st.InsertDecision(&store.DecisionRow{
			SessionID:    "s1",
			Timestamp:    "2025-01-01T00:00:00Z",
			Topic:        "db",
			DecisionText: "decided to use SQLite",
			FilePaths:    `["internal/store/store.go"]`,
		})

		got := buildProjectContext(st, "modify internal/store/store.go")
		if !strings.Contains(got, "decided to use SQLite") {
			t.Errorf("expected decision in context, got %q", got)
		}
	})
}

// ---------------------------------------------------------------------------
// buildCompactContext
// ---------------------------------------------------------------------------

func TestBuildCompactContext(t *testing.T) {
	t.Parallel()

	t.Run("empty session returns empty", func(t *testing.T) {
		t.Parallel()
		st := openTestStore(t)
		st.DB().Exec(`INSERT INTO sessions (id, project_path, project_name, jsonl_path) VALUES ('s1', '/tmp', 'test', '/tmp/t.jsonl')`)

		got := buildCompactContext(st, "s1")
		if got != "" {
			t.Errorf("expected empty for session with no data, got %q", got)
		}
	})

	t.Run("decisions included", func(t *testing.T) {
		t.Parallel()
		st := openTestStore(t)
		st.DB().Exec(`INSERT INTO sessions (id, project_path, project_name, jsonl_path) VALUES ('s1', '/tmp', 'test', '/tmp/t.jsonl')`)
		st.InsertDecision(&store.DecisionRow{
			SessionID:    "s1",
			Timestamp:    "2025-01-01T00:00:00Z",
			Topic:        "db design",
			DecisionText: "use SQLite for persistence",
			FilePaths:    "[]",
		})

		got := buildCompactContext(st, "s1")
		if !strings.Contains(got, "Decisions made this session") {
			t.Errorf("expected decisions header, got %q", got)
		}
		if !strings.Contains(got, "use SQLite") {
			t.Errorf("expected decision text, got %q", got)
		}
	})
}

// ---------------------------------------------------------------------------
// buildSessionStartContext
// ---------------------------------------------------------------------------

func TestBuildSessionStartContext(t *testing.T) {
	t.Parallel()

	t.Run("no previous session returns empty", func(t *testing.T) {
		t.Parallel()
		st := openTestStore(t)
		got := buildSessionStartContext(st, "s1", "/proj")
		if got != "" {
			t.Errorf("expected empty, got %q", got)
		}
	})

	t.Run("compaction warning", func(t *testing.T) {
		t.Parallel()
		st := openTestStore(t)
		st.DB().Exec(`INSERT INTO sessions (id, project_path, project_name, jsonl_path, compact_count) VALUES ('prev', '/proj', 'test', '/tmp/t.jsonl', 5)`)

		got := buildSessionStartContext(st, "new-session", "/proj")
		if !strings.Contains(got, "compaction") {
			t.Errorf("expected compaction warning, got %q", got)
		}
	})
}

// ---------------------------------------------------------------------------
// extractAndSaveDecisions (integration)
// ---------------------------------------------------------------------------

func TestExtractAndSaveDecisions(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	st.DB().Exec(`INSERT INTO sessions (id, project_path, project_name, jsonl_path) VALUES ('s1', '/tmp', 'test', '/tmp/t.jsonl')`)

	text := "I decided to use SQLite for storage. We opted for WAL mode."
	extractAndSaveDecisions(st, "s1", text)

	decisions, err := st.GetDecisions("s1", "", 10)
	if err != nil {
		t.Fatalf("GetDecisions: %v", err)
	}
	if len(decisions) < 2 {
		t.Fatalf("expected >= 2 decisions, got %d", len(decisions))
	}
}

// ---------------------------------------------------------------------------
// splitMarkdownSections (moved from main_test.go)
// ---------------------------------------------------------------------------

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
