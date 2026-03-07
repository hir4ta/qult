package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
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

func TestIsClaudeCodeRelated(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		prompt string
		want   bool
	}{
		{"empty", "", false},
		{"unrelated", "Fix the login bug in auth service", false},
		{"hook keyword", "hookを設定したい", true},
		{"skill keyword", "how do skills work?", true},
		{"mcp keyword", "MCP server configuration", true},
		{"claude code keyword", "Claude Code の使い方", true},
		{"compact keyword", "compaction について教えて", true},
		{"japanese フック", "フックの設定方法を教えて", true},
		{"japanese スキル", "スキルを作りたい", true},
		{"plugin keyword", "pluginをインストールしたい", true},
		{"worktree keyword", "worktree を使ったことある？", true},
		{"general agent (no match)", "my travel agent booked a flight", false},
		{"general rule (no match)", "the golden rule of cooking", false},
		{"frontmatter keyword", "frontmatter の書き方", true},
		{"case insensitive", "HOOKS について", true},
		{"short unrelated", "fix bug", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := isClaudeCodeRelated(tt.prompt); got != tt.want {
				t.Errorf("isClaudeCodeRelated(%q) = %v, want %v", tt.prompt, got, tt.want)
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

func TestRotateCompactMarkers(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		content    string
		maxMarkers int
		wantCount  int
	}{
		{
			name:       "no markers",
			content:    "# Session\n## Status\nactive\n",
			maxMarkers: 3,
			wantCount:  0,
		},
		{
			name:       "under limit",
			content:    "# Session\n## Compact Marker [2026-01-01]\nfirst\n---\n## Compact Marker [2026-01-02]\nsecond\n---\n",
			maxMarkers: 3,
			wantCount:  2,
		},
		{
			name:       "at limit",
			content:    "pre\n## Compact Marker [1]\na\n## Compact Marker [2]\nb\n## Compact Marker [3]\nc\n",
			maxMarkers: 3,
			wantCount:  3,
		},
		{
			name:       "over limit trims oldest",
			content:    "pre\n## Compact Marker [1]\na\n## Compact Marker [2]\nb\n## Compact Marker [3]\nc\n## Compact Marker [4]\nd\n",
			maxMarkers: 3,
			wantCount:  3,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			result := rotateCompactMarkers(tt.content, tt.maxMarkers)
			gotCount := strings.Count(result, "## Compact Marker [")
			if gotCount != tt.wantCount {
				t.Errorf("rotateCompactMarkers() has %d markers, want %d\nresult:\n%s", gotCount, tt.wantCount, result)
			}
		})
	}
}

func TestRotateCompactMarkersKeepsNewest(t *testing.T) {
	t.Parallel()
	content := "# Session\npre\n## Compact Marker [old]\nold data\n## Compact Marker [mid]\nmid data\n## Compact Marker [new]\nnew data\n## Compact Marker [newest]\nnewest data\n"
	result := rotateCompactMarkers(content, 2)

	if !strings.Contains(result, "## Compact Marker [newest]") {
		t.Error("should keep newest marker")
	}
	if !strings.Contains(result, "## Compact Marker [new]") {
		t.Error("should keep second newest marker")
	}
	if strings.Contains(result, "## Compact Marker [old]") {
		t.Error("should have removed old marker")
	}
	if !strings.Contains(result, "# Session") {
		t.Error("should preserve pre-marker content")
	}
}

func TestExtractFirstLines(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		content string
		n       int
		want    string
	}{
		{"empty", "", 3, ""},
		{"headers only", "# Title\n## Section\n", 3, ""},
		{"mixed", "# Title\nLine one\n## H2\nLine two\nLine three\nLine four\n", 2, "Line one | Line two"},
		{"skip comments", "<!-- comment -->\nReal line\n", 3, "Real line"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := extractFirstLines(tt.content, tt.n)
			if got != tt.want {
				t.Errorf("extractFirstLines() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestScoreDecisionConfidence(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		sentence string
		minScore float64
		maxScore float64
	}{
		{
			"rationale boosts confidence",
			"decided to use PostgreSQL because of ACID compliance and scalability",
			0.6, 1.0,
		},
		{
			"alternative comparison boosts confidence",
			"chose FTS5 over pure vector search for deterministic ranking",
			0.6, 1.0,
		},
		{
			"architecture term boosts confidence",
			"settled on a microservice architecture for the API layer",
			0.5, 1.0,
		},
		{
			"code artifact penalty",
			"decided to refactor `handlePreCompact` in cmd/alfred/hooks.go",
			0.0, 0.5,
		},
		{
			"hedging word penalty",
			"just decided to quickly update the variable naming style here",
			0.0, 0.45,
		},
		{
			"plain keyword only gets base score",
			"decided to change the logging format for the output module",
			0.3, 0.55,
		},
		{
			"rationale + alternative = high confidence",
			"chose SQLite over Redis because embedded databases avoid network overhead",
			0.8, 1.0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			score := scoreDecisionConfidence(tt.sentence)
			if score < tt.minScore || score > tt.maxScore {
				t.Errorf("scoreDecisionConfidence(%q) = %.2f, want [%.2f, %.2f]", tt.sentence, score, tt.minScore, tt.maxScore)
			}
		})
	}
}

func TestExpandQuery(t *testing.T) {
	t.Parallel()
	result := expandQuery("hook config")
	if !strings.Contains(result, "hook") {
		t.Error("should contain original keyword")
	}
	if !strings.Contains(result, "hooks") || !strings.Contains(result, "lifecycle") {
		t.Error("should expand 'hook' with synonyms")
	}
	// "config" is 6 chars, should match "config" synonym.
	if !strings.Contains(result, "configuration") {
		t.Error("should expand 'config' with synonyms")
	}
}

func TestIsTrivialDecision(t *testing.T) {
	t.Parallel()
	tests := []struct {
		sentence string
		want     bool
	}{
		{"decided to use SQLite for the knowledge base due to portability", false},
		{"decided to read the file first", true},
		{"decided to check the test output", true},
		{"chose hybrid vector + FTS5 over pure vector search for better recall", false},
		{"chose to skip this", true},
		{"short", true},
		{"going with a 4-file spec structure to avoid duplication with Claude Code native features", false},
		{"going to run tests", true},
	}
	for _, tt := range tests {
		t.Run(tt.sentence, func(t *testing.T) {
			t.Parallel()
			if got := isTrivialDecision(tt.sentence); got != tt.want {
				t.Errorf("isTrivialDecision(%q) = %v, want %v", tt.sentence, got, tt.want)
			}
		})
	}
}

func TestExtractSection(t *testing.T) {
	t.Parallel()
	session := `# Session: my-task

## Status
active

## Currently Working On
Implementing the search feature

## Next Steps
1. Add tests
2. Update docs

## Blockers
None
`
	tests := []struct {
		heading string
		want    string
	}{
		{"## Status", "active"},
		{"## Currently Working On", "Implementing the search feature"},
		{"## Next Steps", "1. Add tests\n2. Update docs"},
		{"## Blockers", "None"},
		{"## Missing Section", ""},
	}
	for _, tt := range tests {
		t.Run(tt.heading, func(t *testing.T) {
			t.Parallel()
			got := extractSection(session, tt.heading)
			if got != tt.want {
				t.Errorf("extractSection(%q) = %q, want %q", tt.heading, got, tt.want)
			}
		})
	}
}

func TestExtractSectionNoFalsePrefix(t *testing.T) {
	t.Parallel()
	content := "## Status\nactive\n\n## StatusUpdate\nsome update\n"
	got := extractSection(content, "## Status")
	if got != "active" {
		t.Errorf("extractSection should not match '## StatusUpdate', got %q", got)
	}
}

func TestExtractListItems(t *testing.T) {
	t.Parallel()
	content := `## Recent Decisions (last 3)
1. Use SQLite for storage
2. 4-file spec structure
3. FTS-only for hooks
`
	items := extractListItems(content, "## Recent Decisions")
	if len(items) != 3 {
		t.Fatalf("extractListItems() = %d items, want 3", len(items))
	}
	if items[0] != "Use SQLite for storage" {
		t.Errorf("items[0] = %q, want %q", items[0], "Use SQLite for storage")
	}
}

func TestExtractListItemsBullets(t *testing.T) {
	t.Parallel()
	content := "## Modified Files\n- src/main.go\n- src/util.go\n"
	items := extractListItems(content, "## Modified Files")
	if len(items) != 2 {
		t.Fatalf("extractListItems() = %d items, want 2", len(items))
	}
}

func TestBuildActiveContextSession(t *testing.T) {
	t.Parallel()
	sd := createTempSpec(t, "test-task")

	result := buildActiveContextSession(sd, "test-task", "", nil, []string{"main.go", "util.go"}, "")

	// Verify activeContext structure.
	if !strings.Contains(result, "# Session: test-task") {
		t.Error("missing session header")
	}
	if !strings.Contains(result, "## Status\nactive") {
		t.Error("missing status section")
	}
	if !strings.Contains(result, "## Currently Working On") {
		t.Error("missing currently working on section")
	}
	if !strings.Contains(result, "## Modified Files (this session)\n- main.go\n- util.go") {
		t.Error("missing modified files")
	}
	if !strings.Contains(result, "## Compact Marker [") {
		t.Error("missing compact marker")
	}
}

func TestBuildActiveContextSessionMergesDecisions(t *testing.T) {
	t.Parallel()
	sd := createTempSpec(t, "test-task")

	// Write existing session with decisions.
	existing := "# Session: test-task\n\n## Status\nactive\n\n## Recent Decisions (last 3)\n1. Old decision A\n2. Old decision B\n"
	if err := sd.WriteFile("session.md", existing); err != nil {
		t.Fatalf("write session: %v", err)
	}

	result := buildActiveContextSession(sd, "test-task", "", []string{"New decision C"}, nil, "")

	if !strings.Contains(result, "Old decision A") {
		t.Error("should preserve old decision A")
	}
	if !strings.Contains(result, "New decision C") {
		t.Error("should include new decision C")
	}
}

func TestBuildActiveContextSessionLegacyFormat(t *testing.T) {
	t.Parallel()
	sd := createTempSpec(t, "legacy-task")

	// Write legacy-format session.md.
	legacy := "# Session: legacy-task\n\n## Current Position\nWorking on auth\n\n## Pending\n1. Fix bug\n\n## Unresolved Issues\nAPI rate limit\n"
	if err := sd.WriteFile("session.md", legacy); err != nil {
		t.Fatalf("write session: %v", err)
	}

	result := buildActiveContextSession(sd, "legacy-task", "", nil, nil, "")

	// Legacy data should be migrated.
	if !strings.Contains(result, "## Currently Working On\nWorking on auth") {
		t.Error("should migrate Current Position to Currently Working On")
	}
	if !strings.Contains(result, "## Next Steps\n1. Fix bug") {
		t.Error("should migrate Pending to Next Steps")
	}
	if !strings.Contains(result, "## Blockers\nAPI rate limit") {
		t.Error("should migrate Unresolved Issues to Blockers")
	}
}

func TestExtractSearchKeywords(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		input string
		max   int
		want  int // expected keyword count
	}{
		{"short prompt", "fix bug", 8, 1}, // "fix" is 3 chars → kept, "bug" is 3 chars → kept
		{"with stop words", "how do I configure the hooks for my project", 8, 3},
		{"technical", "implement hybrid vector search with FTS5", 8, 4},
		{"empty", "", 8, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			result := extractSearchKeywords(tt.input, tt.max)
			words := strings.Fields(result)
			if len(words) < tt.want-1 || len(words) > tt.want+1 {
				t.Errorf("extractSearchKeywords(%q, %d) = %d words (%q), want ~%d", tt.input, tt.max, len(words), result, tt.want)
			}
		})
	}
}

func TestScoreRelevance(t *testing.T) {
	t.Parallel()
	doc := store.DocRow{
		SectionPath: "Hooks Configuration",
		Content:     "Configure hooks in .claude/hooks.json to run commands on lifecycle events like SessionStart, PreCompact.",
	}

	high := scoreRelevance("how to configure hooks for precompact", doc)
	low := scoreRelevance("fix login button css color", doc)

	if high <= low {
		t.Errorf("relevant prompt should score higher: high=%.2f, low=%.2f", high, low)
	}
	if high < 0.15 {
		t.Errorf("relevant prompt score too low: %.2f", high)
	}
}

// createTempSpec creates a temporary spec directory for testing.
func createTempSpec(t *testing.T, slug string) *spec.SpecDir {
	t.Helper()
	dir := t.TempDir()
	sd, err := spec.Init(dir, slug, "test")
	if err != nil {
		t.Fatalf("spec.Init: %v", err)
	}
	return sd
}

// writeFakeTranscript writes a JSONL transcript file with the given lines.
func writeFakeTranscript(t *testing.T, dir string, lines []string) string {
	t.Helper()
	path := filepath.Join(dir, "transcript.jsonl")
	content := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write transcript: %v", err)
	}
	return path
}

// stubExecCommand replaces execCommand with a function that returns
// the given stdout for any command invocation.
func stubExecCommand(t *testing.T, stdout string) {
	t.Helper()
	orig := execCommand
	execCommand = func(name string, args ...string) *exec.Cmd {
		cmd := exec.Command("echo", "-n", stdout)
		return cmd
	}
	t.Cleanup(func() { execCommand = orig })
}

// captureStdout captures os.Stdout output during fn execution.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	origStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	os.Stdout = w
	t.Cleanup(func() { os.Stdout = origStdout })

	fn()

	w.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read pipe: %v", err)
	}
	return string(out)
}

func TestHandlePreCompactIntegration(t *testing.T) {
	dir := t.TempDir()
	sd, err := spec.Init(dir, "precompact-test", "test precompact flow")
	if err != nil {
		t.Fatalf("spec.Init: %v", err)
	}

	// Create a fake transcript with user messages, decisions, and structured patterns.
	transcriptLines := []string{
		`{"type":"human","content":"implement the database layer"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll implement the database layer. I decided to use PostgreSQL for better scalability and ACID compliance."}]}}`,
		`{"type":"human","content":"what about the search feature?"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"For search, let me analyze the options.\n\n**Chosen:** hybrid vector + FTS5 for best recall and precision"}]}}`,
		`{"type":"human","content":"sounds good, proceed"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll proceed with the implementation now."}]}}`,
	}
	transcriptPath := writeFakeTranscript(t, dir, transcriptLines)

	// Stub execCommand to return mock git output.
	stubExecCommand(t, "cmd/alfred/hooks.go\ninternal/spec/spec.go")

	// Capture stdout (emitCompactionInstructions writes there).
	output := captureStdout(t, func() {
		handlePreCompact(dir, transcriptPath, "focus on search feature")
	})

	// Verify session.md was written.
	session, err := sd.ReadFile(spec.FileSession)
	if err != nil {
		t.Fatalf("read session.md: %v", err)
	}

	// Verify activeContext format sections.
	if !strings.Contains(session, "## Status") {
		t.Error("session.md missing '## Status'")
	}
	if !strings.Contains(session, "## Currently Working On") {
		t.Error("session.md missing '## Currently Working On'")
	}
	if !strings.Contains(session, "## Recent Decisions") {
		t.Error("session.md missing '## Recent Decisions'")
	}

	// Verify decisions extracted from transcript.
	if !strings.Contains(session, "PostgreSQL") {
		t.Error("session.md should contain decision about PostgreSQL")
	}

	// Verify modified files from git stub.
	if !strings.Contains(session, "cmd/alfred/hooks.go") {
		t.Error("session.md should contain modified file hooks.go")
	}
	if !strings.Contains(session, "internal/spec/spec.go") {
		t.Error("session.md should contain modified file spec.go")
	}

	// Verify compact marker with user instructions.
	if !strings.Contains(session, "## Compact Marker [") {
		t.Error("session.md missing compact marker")
	}
	if !strings.Contains(session, "focus on search feature") {
		t.Error("session.md should contain user compact instructions")
	}

	// Verify context snapshot from transcript.
	if !strings.Contains(session, "implement the database layer") {
		t.Error("session.md should contain context snapshot from user messages")
	}

	// Verify compaction instructions were emitted to stdout.
	if !strings.Contains(output, "Butler Protocol") {
		t.Error("stdout should contain Butler Protocol compaction instructions")
	}
	if !strings.Contains(output, "precompact-test") {
		t.Error("stdout should contain task slug")
	}
}

func TestInjectButlerContextCompact(t *testing.T) {
	dir := t.TempDir()
	sd, err := spec.Init(dir, "compact-ctx", "test compact context")
	if err != nil {
		t.Fatalf("spec.Init: %v", err)
	}

	// Write meaningful content to all 4 spec files.
	if err := sd.WriteFile(spec.FileRequirements, "# Requirements\n\nBuild a search engine with hybrid vector + FTS5."); err != nil {
		t.Fatalf("write requirements: %v", err)
	}
	if err := sd.WriteFile(spec.FileDesign, "# Design\n\nUse SQLite for storage with ncruces/go-sqlite3."); err != nil {
		t.Fatalf("write design: %v", err)
	}
	if err := sd.WriteFile(spec.FileDecisions, "# Decisions\n\n## 2026-01-01 Storage Engine\n- **Chosen:** SQLite"); err != nil {
		t.Fatalf("write decisions: %v", err)
	}
	sessionContent := "# Session: compact-ctx\n\n## Status\nactive\n\n## Currently Working On\nSearch implementation\n\n## Compact Marker [2026-01-01 10:00:00]\nfirst compact\n---\n"
	if err := sd.WriteFile(spec.FileSession, sessionContent); err != nil {
		t.Fatalf("write session: %v", err)
	}

	// First compact: should inject all 4 files.
	output1 := captureStdout(t, func() {
		injectButlerContext(dir, "compact")
	})

	if !strings.Contains(output1, "Requirements") {
		t.Error("first compact should include requirements content")
	}
	if !strings.Contains(output1, "Design") {
		t.Error("first compact should include design content")
	}
	if !strings.Contains(output1, "Decisions") {
		t.Error("first compact should include decisions content")
	}
	if !strings.Contains(output1, "Search implementation") {
		t.Error("first compact should include session content")
	}
	if !strings.Contains(output1, "Full context recovery") {
		t.Error("first compact should say 'Full context recovery'")
	}

	// Add a second compact marker to session.md to simulate subsequent compact.
	sessionContent2 := sessionContent + "\n## Compact Marker [2026-01-01 11:00:00]\nsecond compact\n---\n"
	if err := sd.WriteFile(spec.FileSession, sessionContent2); err != nil {
		t.Fatalf("write session: %v", err)
	}

	// Second compact: should inject only session.md (lightweight).
	output2 := captureStdout(t, func() {
		injectButlerContext(dir, "compact")
	})

	if !strings.Contains(output2, "Lightweight recovery") {
		t.Error("subsequent compact should say 'Lightweight recovery'")
	}
	if !strings.Contains(output2, "Search implementation") {
		t.Error("subsequent compact should still include session content")
	}
	// Requirements/Design should NOT appear in lightweight mode.
	if strings.Contains(output2, "hybrid vector + FTS5") {
		t.Error("subsequent compact should NOT include full requirements content")
	}
	if strings.Contains(output2, "ncruces/go-sqlite3") {
		t.Error("subsequent compact should NOT include full design content")
	}
}

func TestInjectButlerContextNormal(t *testing.T) {
	dir := t.TempDir()
	sd, err := spec.Init(dir, "normal-ctx", "test normal startup")
	if err != nil {
		t.Fatalf("spec.Init: %v", err)
	}

	sessionContent := "# Session: normal-ctx\n\n## Status\nactive\n\n## Currently Working On\nNormal startup test\n"
	if err := sd.WriteFile(spec.FileSession, sessionContent); err != nil {
		t.Fatalf("write session: %v", err)
	}

	// Write requirements to verify they are NOT injected on normal startup.
	if err := sd.WriteFile(spec.FileRequirements, "# Requirements\n\nShould not appear in normal startup."); err != nil {
		t.Fatalf("write requirements: %v", err)
	}

	output := captureStdout(t, func() {
		injectButlerContext(dir, "startup")
	})

	if !strings.Contains(output, "Normal startup test") {
		t.Error("normal startup should include session.md content")
	}
	if !strings.Contains(output, "Active Task 'normal-ctx'") {
		t.Error("normal startup should include task slug in header")
	}
	if strings.Contains(output, "Should not appear") {
		t.Error("normal startup should NOT include requirements content")
	}
}

func TestHandlePreCompactNoSpec(t *testing.T) {
	dir := t.TempDir()

	// No .alfred/ directory exists. handlePreCompact should not panic.
	stubExecCommand(t, "")

	output := captureStdout(t, func() {
		handlePreCompact(dir, "", "")
	})

	// Should produce no output (graceful no-op).
	if output != "" {
		t.Errorf("handlePreCompact with no spec should produce no stdout, got %q", output)
	}
}

func TestExtractDecisionsFromTranscript(t *testing.T) {
	dir := t.TempDir()

	transcriptLines := []string{
		// Trivial decision (should be filtered).
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I decided to read the file first to understand the structure."}]}}`,
		// Real keyword decision (should be kept).
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"After analyzing the options, I decided to use hybrid search for better recall and precision across large document sets."}]}}`,
		// Structured decision (should be kept).
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Comparing search backends:\n**Chosen:** FTS5 over pure vector for deterministic ranking and lower latency"}]}}`,
		// Another trivial decision (should be filtered).
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I decided to run the tests to verify."}]}}`,
		// User message (should be ignored entirely).
		`{"type":"human","content":"decided to use Redis for caching"}`,
		// Duplicate of the hybrid search decision (should be deduplicated).
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"After analyzing the options, I decided to use hybrid search for better recall and precision across large document sets."}]}}`,
	}

	transcriptPath := writeFakeTranscript(t, dir, transcriptLines)
	decisions := extractDecisionsFromTranscript(transcriptPath)

	// Verify trivial decisions are filtered.
	for _, d := range decisions {
		lower := strings.ToLower(d)
		if strings.Contains(lower, "decided to read") {
			t.Errorf("trivial decision should be filtered: %q", d)
		}
		if strings.Contains(lower, "decided to run") {
			t.Errorf("trivial decision should be filtered: %q", d)
		}
	}

	// Verify real decisions are kept.
	foundHybrid := false
	foundFTS5 := false
	for _, d := range decisions {
		lower := strings.ToLower(d)
		if strings.Contains(lower, "hybrid search") {
			foundHybrid = true
		}
		if strings.Contains(lower, "fts5") {
			foundFTS5 = true
		}
	}
	if !foundHybrid {
		t.Errorf("should keep real keyword decision about hybrid search, got: %v", decisions)
	}
	if !foundFTS5 {
		t.Errorf("should keep structured decision about FTS5, got: %v", decisions)
	}

	// Verify user messages are not extracted as decisions.
	for _, d := range decisions {
		if strings.Contains(strings.ToLower(d), "redis") {
			t.Errorf("user message should not be extracted as decision: %q", d)
		}
	}

	// Verify deduplication: count hybrid search mentions.
	hybridCount := 0
	for _, d := range decisions {
		if strings.Contains(strings.ToLower(d), "hybrid search") {
			hybridCount++
		}
	}
	if hybridCount > 1 {
		t.Errorf("duplicate decisions should be removed, got %d mentions of hybrid search", hybridCount)
	}
}

func TestReadFileTail(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	// Small file: should return entire content.
	small := filepath.Join(dir, "small.txt")
	if err := os.WriteFile(small, []byte("line1\nline2\nline3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	data, err := readFileTail(small, 1024)
	if err != nil {
		t.Fatalf("readFileTail small: %v", err)
	}
	if !strings.Contains(string(data), "line1") {
		t.Error("small file should return all content")
	}

	// Large file: should return only the tail.
	large := filepath.Join(dir, "large.txt")
	var buf strings.Builder
	for i := range 200 {
		fmt.Fprintf(&buf, "line %d: some padding content here\n", i)
	}
	if err := os.WriteFile(large, []byte(buf.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	data, err = readFileTail(large, 256)
	if err != nil {
		t.Fatalf("readFileTail large: %v", err)
	}
	if len(data) > 256 {
		t.Errorf("tail should be <= 256 bytes, got %d", len(data))
	}
	// Should not start mid-line (first partial line is skipped).
	if data[0] == 0 {
		t.Error("should not contain null bytes")
	}

	// Non-existent file.
	_, err = readFileTail(filepath.Join(dir, "nope.txt"), 100)
	if err == nil {
		t.Error("expected error for non-existent file")
	}
}

func TestExtractTextContent(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		entry transcriptEntry
		want  string
	}{
		{
			"direct string content",
			transcriptEntry{Content: "hello world"},
			"hello world",
		},
		{
			"message string content",
			transcriptEntry{
				Message: struct {
					Role    string `json:"role"`
					Content any    `json:"content"`
				}{Role: "assistant", Content: "from message"},
			},
			"from message",
		},
		{
			"content blocks array",
			transcriptEntry{
				Content: []any{
					map[string]any{"type": "text", "text": "block text"},
				},
			},
			"block text",
		},
		{
			"message content blocks",
			transcriptEntry{
				Message: struct {
					Role    string `json:"role"`
					Content any    `json:"content"`
				}{
					Role: "assistant",
					Content: []any{
						map[string]any{"type": "text", "text": "msg block"},
					},
				},
			},
			"msg block",
		},
		{
			"empty entry",
			transcriptEntry{},
			"",
		},
		{
			"content blocks without text key",
			transcriptEntry{
				Content: []any{
					map[string]any{"type": "tool_use", "name": "Read"},
				},
			},
			"",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := extractTextContent(tt.entry)
			if got != tt.want {
				t.Errorf("extractTextContent() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestHandleUserPromptSubmitEarlyReturns(t *testing.T) {
	// Test config reminder path.
	output := captureStdout(t, func() {
		handleUserPromptSubmit(&hookEvent{Prompt: ".claude/hooks.json を確認して"})
	})
	if !strings.Contains(output, "alfred") {
		t.Error("config path prompt should trigger reminder")
	}

	// Note: keyword filtering removed; LLM prompt hook handles relevance gating.
	// The command hook no longer rejects "unrelated" prompts — it proceeds to FTS search.

	// Test short prompt (< 10 runes).
	output = captureStdout(t, func() {
		handleUserPromptSubmit(&hookEvent{Prompt: "hook?"})
	})
	if output != "" {
		t.Errorf("short prompt should produce no output, got %q", output)
	}
}

func TestTruncateStr(t *testing.T) {
	t.Parallel()
	tests := []struct {
		input  string
		maxLen int
		want   string
	}{
		{"short", 10, "short"},
		{"hello\nworld", 20, "hello world"},
		{"abcdefghij", 5, "abcde..."},
		{"", 5, ""},
		{"  spaces  ", 20, "spaces"},
		{"日本語テスト", 3, "日本語..."},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			t.Parallel()
			got := truncateStr(tt.input, tt.maxLen)
			if got != tt.want {
				t.Errorf("truncateStr(%q, %d) = %q, want %q", tt.input, tt.maxLen, got, tt.want)
			}
		})
	}
}

func TestHandlePreToolUse(t *testing.T) {
	// Matching path: should output reminder.
	output := captureStdout(t, func() {
		handlePreToolUse(&hookEvent{
			ToolInput: map[string]any{"file_path": "/project/.claude/rules/test.md"},
		})
	})
	if !strings.Contains(output, "alfred") {
		t.Error("should output reminder for .claude/ path")
	}

	// Non-matching path: no output.
	output = captureStdout(t, func() {
		handlePreToolUse(&hookEvent{
			ToolInput: map[string]any{"file_path": "/project/src/main.go"},
		})
	})
	if output != "" {
		t.Errorf("should not output reminder for non-.claude/ path, got %q", output)
	}
}

func TestGetModifiedFiles(t *testing.T) {
	// Create a git repo in temp dir.
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init"},
		{"config", "user.email", "test@test.com"},
		{"config", "user.name", "test"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if err := cmd.Run(); err != nil {
			t.Skipf("git setup failed: %v", err)
		}
	}
	// Create and commit a file.
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "add", "a.go")
	cmd.Dir = dir
	cmd.Run()
	cmd = exec.Command("git", "commit", "-m", "init")
	cmd.Dir = dir
	cmd.Run()

	// Modify the file.
	os.WriteFile(filepath.Join(dir, "a.go"), []byte("package main\nfunc f(){}\n"), 0o644)

	files := getModifiedFiles(dir)
	found := false
	for _, f := range files {
		if f == "a.go" {
			found = true
		}
	}
	if !found {
		t.Errorf("getModifiedFiles should include a.go, got %v", files)
	}
}

func TestIngestProjectClaudeMD(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	defer st.Close()

	// No CLAUDE.md: should silently skip.
	ingestProjectClaudeMD(st, dir)

	// Create CLAUDE.md.
	claudeMD := "# Project\n\n## Commands\ngo test ./...\n\n## Rules\nFollow conventions\n"
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte(claudeMD), 0o644); err != nil {
		t.Fatal(err)
	}

	ingestProjectClaudeMD(st, dir)

	// Verify docs were inserted.
	docs, err := st.SearchDocsFTS("Commands", "project", 5)
	if err != nil {
		t.Fatalf("SearchDocsFTS: %v", err)
	}
	if len(docs) == 0 {
		t.Error("expected docs after ingestProjectClaudeMD")
	}
}

func TestExtractTranscriptContext(t *testing.T) {
	dir := t.TempDir()
	lines := []string{
		`{"type":"human","content":"first user message"}`,
		`{"type":"assistant","message":{"role":"assistant","content":"assistant response one"}}`,
		`{"type":"human","content":"second user message"}`,
		`{"type":"tool_error","content":"connection refused"}`,
		`{"type":"assistant","message":{"role":"assistant","content":"assistant response two"}}`,
	}
	path := writeFakeTranscript(t, dir, lines)

	result := extractTranscriptContext(path)

	if !strings.Contains(result, "first user message") {
		t.Error("should contain user messages")
	}
	if !strings.Contains(result, "assistant response") {
		t.Error("should contain assistant summaries")
	}
	if !strings.Contains(result, "connection refused") {
		t.Error("should contain tool errors")
	}
	if !strings.Contains(result, "Recent user requests:") {
		t.Error("should have user section header")
	}
	if !strings.Contains(result, "Recent errors") {
		t.Error("should have errors section header")
	}
}

func TestExtractTranscriptContextEmpty(t *testing.T) {
	result := extractTranscriptContext("/nonexistent/path/transcript.jsonl")
	if result != "" {
		t.Errorf("non-existent file should return empty, got %q", result)
	}
}
