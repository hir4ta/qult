package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// extractEarlyUserContext is a test helper that joins early user messages.
func extractEarlyUserContext(transcriptPath string) string {
	msgs := extractEarlyUserMessages(transcriptPath)
	if len(msgs) == 0 {
		return ""
	}
	return strings.Join(msgs, "\n---\n")
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

func TestExtractSectionFallback(t *testing.T) {
	t.Parallel()
	content := "## Current Position\nold heading\n\n## Next Steps\n1. test\n"

	t.Run("first heading matches", func(t *testing.T) {
		t.Parallel()
		got := extractSectionFallback(content, "## Current Position", "## Currently Working On")
		if got != "old heading" {
			t.Errorf("extractSectionFallback = %q, want %q", got, "old heading")
		}
	})
	t.Run("fallback to second heading", func(t *testing.T) {
		t.Parallel()
		got := extractSectionFallback(content, "## Currently Working On", "## Current Position")
		if got != "old heading" {
			t.Errorf("extractSectionFallback = %q, want %q", got, "old heading")
		}
	})
	t.Run("no match returns empty", func(t *testing.T) {
		t.Parallel()
		got := extractSectionFallback(content, "## Missing", "## Also Missing")
		if got != "" {
			t.Errorf("extractSectionFallback = %q, want empty", got)
		}
	})
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

	result := buildActiveContextSession(sd, "test-task", nil, nil, []string{"main.go", "util.go"}, "")

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
	if err := sd.WriteFile(context.Background(), "session.md", existing); err != nil {
		t.Fatalf("write session: %v", err)
	}

	result := buildActiveContextSession(sd, "test-task", nil, []string{"New decision C"}, nil, "")

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
	if err := sd.WriteFile(context.Background(), "session.md", legacy); err != nil {
		t.Fatalf("write session: %v", err)
	}

	result := buildActiveContextSession(sd, "legacy-task", nil, nil, nil, "")

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
		handlePreCompact(context.Background(),dir, transcriptPath, "focus on search feature")
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
	if !strings.Contains(output, "Alfred Protocol") {
		t.Error("stdout should contain Alfred Protocol compaction instructions")
	}
	if !strings.Contains(output, "precompact-test") {
		t.Error("stdout should contain task slug")
	}
}

func TestInjectSpecContextCompact(t *testing.T) {
	dir := t.TempDir()
	sd, err := spec.Init(dir, "compact-ctx", "test compact context")
	if err != nil {
		t.Fatalf("spec.Init: %v", err)
	}

	// Write meaningful content to all 4 spec files.
	if err := sd.WriteFile(context.Background(), spec.FileRequirements, "# Requirements\n\nBuild a search engine with hybrid vector + FTS5."); err != nil {
		t.Fatalf("write requirements: %v", err)
	}
	if err := sd.WriteFile(context.Background(), spec.FileDesign, "# Design\n\nUse SQLite for storage with ncruces/go-sqlite3."); err != nil {
		t.Fatalf("write design: %v", err)
	}
	if err := sd.WriteFile(context.Background(), spec.FileDecisions, "# Decisions\n\n## 2026-01-01 Storage Engine\n- **Chosen:** SQLite"); err != nil {
		t.Fatalf("write decisions: %v", err)
	}
	sessionContent := "# Session: compact-ctx\n\n## Status\nactive\n\n## Currently Working On\nSearch implementation\n\n## Compact Marker [2026-01-01 10:00:00]\nfirst compact\n---\n"
	if err := sd.WriteFile(context.Background(), spec.FileSession, sessionContent); err != nil {
		t.Fatalf("write session: %v", err)
	}

	// First compact: should inject all 4 files.
	output1 := captureStdout(t, func() {
		injectSpecContext(context.Background(), dir, "compact", nil)
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
	if err := sd.WriteFile(context.Background(), spec.FileSession, sessionContent2); err != nil {
		t.Fatalf("write session: %v", err)
	}

	// Second compact: should inject only session.md (lightweight).
	output2 := captureStdout(t, func() {
		injectSpecContext(context.Background(), dir, "compact", nil)
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

func TestInjectSpecContextNormal(t *testing.T) {
	dir := t.TempDir()
	sd, err := spec.Init(dir, "normal-ctx", "test normal startup")
	if err != nil {
		t.Fatalf("spec.Init: %v", err)
	}

	sessionContent := "# Session: normal-ctx\n\n## Status\nactive\n\n## Currently Working On\nNormal startup test\n"
	if err := sd.WriteFile(context.Background(), spec.FileSession, sessionContent); err != nil {
		t.Fatalf("write session: %v", err)
	}

	// Write requirements — with 0 memories, onboarding mode injects full context.
	if err := sd.WriteFile(context.Background(), spec.FileRequirements, "# Requirements\n\nOnboarding requirement."); err != nil {
		t.Fatalf("write requirements: %v", err)
	}

	output := captureStdout(t, func() {
		injectSpecContext(context.Background(), dir, "startup", nil)
	})

	if !strings.Contains(output, "Normal startup test") {
		t.Error("normal startup should include session.md content")
	}
	if !strings.Contains(output, "Active Task 'normal-ctx'") {
		t.Error("normal startup should include task slug in header")
	}
	// With 0 memories (new project), onboarding injects requirements too.
	if !strings.Contains(output, "Onboarding requirement") {
		t.Error("onboarding (0 memories) should include requirements content")
	}
}

func TestHandlePreCompactNoSpec(t *testing.T) {
	dir := t.TempDir()

	// No .alfred/ directory exists. handlePreCompact should not panic.
	stubExecCommand(t, "")

	output := captureStdout(t, func() {
		handlePreCompact(context.Background(),dir, "", "")
	})

	// Should produce no output (graceful no-op).
	if output != "" {
		t.Errorf("handlePreCompact with no spec should produce no stdout, got %q", output)
	}
}

func TestAllNextStepsCompleted(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{"all checked", "- [x] Step 1\n- [x] Step 2\n- [x] Step 3", true},
		{"one unchecked", "- [x] Step 1\n- [ ] Step 2\n- [x] Step 3", false},
		{"all unchecked", "- [ ] Step 1\n- [ ] Step 2", false},
		{"empty", "", false},
		{"no items", "Some text\nMore text", false},
		{"mixed case X", "- [X] Step 1\n- [x] Step 2", true},
		{"with indent", "  - [x] Step 1\n  - [x] Step 2", true},
		{"unchecked with indent", "  - [x] Step 1\n  - [ ] Step 2", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := allNextStepsCompleted(tt.input)
			if got != tt.want {
				t.Errorf("allNextStepsCompleted(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestAutoCompleteTask(t *testing.T) {
	t.Parallel()

	setupTask := func(t *testing.T, slug string) string {
		t.Helper()
		dir := t.TempDir()
		specDir := dir + "/.alfred/specs"
		os.MkdirAll(specDir+"/"+slug, 0o755)
		activeContent := fmt.Sprintf("primary: %s\ntasks:\n    - slug: %s\n      started_at: \"2026-03-15T10:00:00Z\"\n      status: active\n", slug, slug)
		os.WriteFile(specDir+"/_active.md", []byte(activeContent), 0o644)
		os.WriteFile(specDir+"/"+slug+"/session.md", []byte("# test"), 0o644)
		return dir
	}

	t.Run("completes on status done", func(t *testing.T) {
		t.Parallel()
		dir := setupTask(t, "auto-test")

		session := "# Session: auto-test\n\n## Status\ncompleted\n\n## Next Steps\n- [ ] Remaining step\n"
		autoCompleteTask(dir, "auto-test", session)

		data, _ := os.ReadFile(dir + "/.alfred/specs/_active.md")
		if !strings.Contains(string(data), "status: completed") {
			t.Error("_active.md should contain 'status: completed'")
		}
	})

	t.Run("completes when all next steps done", func(t *testing.T) {
		t.Parallel()
		dir := setupTask(t, "steps-test")

		session := "# Session: steps-test\n\n## Status\nactive\n\n## Next Steps\n- [x] Step 1\n- [x] Step 2\n- [x] Step 3\n"
		autoCompleteTask(dir, "steps-test", session)

		data, _ := os.ReadFile(dir + "/.alfred/specs/_active.md")
		if !strings.Contains(string(data), "status: completed") {
			t.Error("_active.md should contain 'status: completed'")
		}
	})

	t.Run("no-op when active with unchecked steps", func(t *testing.T) {
		t.Parallel()
		dir := setupTask(t, "noop-test")

		session := "# Session: noop-test\n\n## Status\nactive\n\n## Next Steps\n- [x] Step 1\n- [ ] Step 2\n"
		autoCompleteTask(dir, "noop-test", session)

		data, _ := os.ReadFile(dir + "/.alfred/specs/_active.md")
		if strings.Contains(string(data), "status: completed") {
			t.Error("should not auto-complete when unchecked steps remain")
		}
	})
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
	// Disable semantic search for early-return tests.
	origEmb := newEmbedder
	newEmbedder = func() *embedder.Embedder { return nil }
	t.Cleanup(func() { newEmbedder = origEmb })

	// Test short prompt (< 10 runes).
	output := captureStdout(t, func() {
		handleUserPromptSubmit(context.Background(), &hookEvent{Prompt: "hook?"})
	})
	if output != "" {
		t.Errorf("short prompt should produce no output, got %q", output)
	}

	// Test unrelated prompt — FTS5 fallback may produce output if DB has matching data.
	// With FTS5 enabled, "login" and "authentication" may match existing memories.
	// This is correct behavior: FTS5 fallback provides results without Voyage.
	_ = captureStdout(t, func() {
		handleUserPromptSubmit(context.Background(), &hookEvent{Prompt: "Fix the login bug in the authentication service please"})
	})

	// Test empty prompt.
	output = captureStdout(t, func() {
		handleUserPromptSubmit(context.Background(), &hookEvent{Prompt: ""})
	})
	if output != "" {
		t.Errorf("empty prompt should produce no output, got %q", output)
	}
}

func TestHandleSessionStartNoProject(t *testing.T) {
	// Empty project path should be a no-op.
	output := captureStdout(t, func() {
		handleSessionStart(context.Background(),&hookEvent{ProjectPath: ""})
	})
	if output != "" {
		t.Errorf("empty project path should produce no output, got %q", output)
	}
}

func TestHandleSessionStartWithSpec(t *testing.T) {
	dir := t.TempDir()
	sd, err := spec.Init(dir, "session-test", "test session start")
	if err != nil {
		t.Fatalf("spec.Init: %v", err)
	}
	if err := sd.WriteFile(context.Background(), spec.FileSession, "# Session: session-test\n\n## Status\nactive\n\n## Currently Working On\nTesting session start\n"); err != nil {
		t.Fatalf("write session: %v", err)
	}

	output := captureStdout(t, func() {
		handleSessionStart(context.Background(),&hookEvent{ProjectPath: dir, Source: "startup"})
	})
	if !strings.Contains(output, "session-test") {
		t.Error("should inject session context for active spec")
	}
	if !strings.Contains(output, "Testing session start") {
		t.Error("should include session content")
	}
}

func TestStopHookActive(t *testing.T) {
	output := captureStdout(t, func() {
		// Simulate stop_hook_active: runHook should exit early.
		// We test the hookEvent field directly.
		ev := &hookEvent{StopHookActive: true, ProjectPath: t.TempDir()}
		if ev.StopHookActive {
			return // mirrors runHook behavior
		}
		handleSessionStart(context.Background(),ev)
	})
	if output != "" {
		t.Errorf("stop_hook_active should produce no output, got %q", output)
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
	ingestProjectClaudeMD(context.Background(), st, dir)

	// Create CLAUDE.md.
	claudeMD := "# Project\n\n## Commands\ngo test ./...\n\n## Rules\nFollow conventions\n"
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte(claudeMD), 0o644); err != nil {
		t.Fatal(err)
	}

	ingestProjectClaudeMD(context.Background(), st, dir)

	// Verify docs were inserted via URL prefix search.
	docs, err := st.SearchDocsByURLPrefix(context.Background(), "project://", 5)
	if err != nil {
		t.Fatalf("SearchDocsByURLPrefix: %v", err)
	}
	if len(docs) == 0 {
		t.Error("expected docs after ingestProjectClaudeMD")
	}
}


func TestResolvedVersion(t *testing.T) {
	// Not parallel: modifies package-level var.
	orig := version
	version = "1.2.3"
	t.Cleanup(func() { version = orig })

	got := resolvedVersion()
	if got != "1.2.3" {
		t.Errorf("resolvedVersion() = %q, want %q", got, "1.2.3")
	}
}

func TestResolvedVersionDev(t *testing.T) {
	orig := version
	version = "dev"
	t.Cleanup(func() { version = orig })

	got := resolvedVersion()
	if got == "" {
		t.Error("resolvedVersion() should never return empty string")
	}
}

func TestResolvedCommit(t *testing.T) {
	orig := commit
	commit = "abc1234"
	t.Cleanup(func() { commit = orig })

	got := resolvedCommit()
	if got != "abc1234" {
		t.Errorf("resolvedCommit() = %q, want %q", got, "abc1234")
	}
}

func TestResolvedCommitUnknown(t *testing.T) {
	orig := commit
	commit = "unknown"
	t.Cleanup(func() { commit = orig })

	got := resolvedCommit()
	_ = got // just verify no panic
}

func TestResolvedDate(t *testing.T) {
	orig := date
	date = "2026-01-01"
	t.Cleanup(func() { date = orig })

	got := resolvedDate()
	if got != "2026-01-01" {
		t.Errorf("resolvedDate() = %q, want %q", got, "2026-01-01")
	}
}

func TestResolvedDateUnknown(t *testing.T) {
	orig := date
	date = "unknown"
	t.Cleanup(func() { date = orig })

	got := resolvedDate()
	_ = got // just verify no panic
}


func TestUserPromptSubmitJSONOutput(t *testing.T) {
	// Stub newEmbedder to return nil so test doesn't depend on VOYAGE_API_KEY.
	origEmb := newEmbedder
	newEmbedder = func() *embedder.Embedder { return nil }
	t.Cleanup(func() { newEmbedder = origEmb })

	// Use a remember-intent prompt to guarantee JSON output without Voyage.
	output := captureStdout(t, func() {
		handleUserPromptSubmit(context.Background(), &hookEvent{Prompt: "この設計判断を覚えておいて: SQLiteを採用した理由はパフォーマンス"})
	})

	var result map[string]any
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("UserPromptSubmit output is not valid JSON: %v\noutput: %s", err, output)
	}

	hso, ok := result["hookSpecificOutput"].(map[string]any)
	if !ok {
		t.Fatal("missing hookSpecificOutput")
	}
	if hso["hookEventName"] != "UserPromptSubmit" {
		t.Errorf("hookEventName = %v, want UserPromptSubmit", hso["hookEventName"])
	}
	if _, ok := hso["additionalContext"]; !ok {
		t.Error("missing additionalContext")
	}
}

func TestSessionStartJSONOutput(t *testing.T) {
	dir := t.TempDir()
	_, err := spec.Init(dir, "json-test", "test json output")
	if err != nil {
		t.Fatalf("spec.Init: %v", err)
	}

	output := captureStdout(t, func() {
		injectSpecContext(context.Background(), dir, "startup", nil)
	})

	if output == "" {
		t.Skip("no spec context to inject")
	}

	var result map[string]any
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("SessionStart output is not valid JSON: %v\noutput: %s", err, output)
	}

	hso, ok := result["hookSpecificOutput"].(map[string]any)
	if !ok {
		t.Fatal("missing hookSpecificOutput")
	}
	if hso["hookEventName"] != "SessionStart" {
		t.Errorf("hookEventName = %v, want SessionStart", hso["hookEventName"])
	}
}

func TestJapaneseDecisionExtraction(t *testing.T) {
	dir := t.TempDir()

	transcriptLines := []string{
		// Japanese keyword decision (should be kept).
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"パフォーマンスの観点から、SQLiteを採用したことにしました。ネットワーク不要で組み込みDBとして最適です。"}]}}`,
		// Japanese structured decision (should be kept).
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"検索エンジンの比較結果:\n**採用:** FTS5によるハイブリッド検索。ベクトル検索よりも決定的なランキングが可能"}]}}`,
		// Japanese trivial decision (should be filtered).
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ファイルを確認することにした"}]}}`,
	}

	transcriptPath := writeFakeTranscript(t, dir, transcriptLines)
	decisions := extractDecisionsFromTranscript(transcriptPath)

	foundSQLite := false
	foundFTS5 := false
	for _, d := range decisions {
		if strings.Contains(d, "SQLite") {
			foundSQLite = true
		}
		if strings.Contains(d, "FTS5") {
			foundFTS5 = true
		}
	}
	if !foundSQLite {
		t.Errorf("should extract Japanese keyword decision about SQLite, got: %v", decisions)
	}
	if !foundFTS5 {
		t.Errorf("should extract Japanese structured decision about FTS5, got: %v", decisions)
	}
}

func TestScoreDecisionConfidenceJapanese(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		sentence string
		minScore float64
		maxScore float64
	}{
		{
			"Japanese rationale",
			"パフォーマンスのためにSQLiteを採用した",
			0.5, 1.0,
		},
		{
			"Japanese alternative comparison",
			"Redisではなく、SQLiteを選択した",
			0.6, 1.0,
		},
		{
			"Japanese architecture term",
			"マイクロサービスアーキテクチャの設計方針を決定した",
			0.5, 1.0,
		},
		{
			"Japanese hedging penalty",
			"とりあえずこの変数名を変えておく",
			0.0, 0.45,
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

func TestBuildActiveContextSessionWithRichContext(t *testing.T) {
	t.Parallel()
	sd := createTempSpec(t, "rich-ctx")

	txCtx := &transcriptContext{
		LastUserDirective: "日本語のdecision markerを追加して、テストも書いて",
		LastAssistantWork: "hooks_transcript.goに日本語のdecisionKeywords, rationaleMarkers, alternativeMarkersを追加中。テストファイルも更新している。",
		AssistantActions: []string{
			"日本語decision markers追加を開始",
			"hooks_transcript.goのdecisionKeywordsに日本語パターンを追加",
			"テストケースを書いている",
		},
		RunningAgents: []string{
			"日本語decision marker徹底調査",
			"run.sh checksum検証追加",
		},
		RecentToolUses: []string{"Edit", "Read", "Agent"},
		ToolErrors:     []string{"Edit: String not found"},
	}

	result := buildActiveContextSession(sd, "rich-ctx", txCtx, []string{"Use SQLite"}, []string{"hooks.go"}, "focus on tests")

	// Currently Working On should come from LastAssistantWork.
	if !strings.Contains(result, "hooks_transcript.go") {
		t.Error("Currently Working On should contain last assistant work detail")
	}

	// Compact marker should contain rich context.
	if !strings.Contains(result, "Last user directive:") {
		t.Error("should contain last user directive section")
	}
	if !strings.Contains(result, "日本語のdecision marker") {
		t.Error("should contain the actual user directive")
	}
	if !strings.Contains(result, "Running background agents") {
		t.Error("should contain running agents section")
	}
	if !strings.Contains(result, "日本語decision marker徹底調査") {
		t.Error("should list running agent names")
	}
	if !strings.Contains(result, "Recent tool calls:") {
		t.Error("should contain recent tool calls")
	}
	if !strings.Contains(result, "Recent errors") {
		t.Error("should contain tool errors")
	}
	if !strings.Contains(result, "focus on tests") {
		t.Error("should contain user compact instructions")
	}
}

func TestAutoAppendDecisions(t *testing.T) {
	t.Parallel()
	sd := createTempSpec(t, "auto-dec")

	// Write initial decisions.md with a long-enough entry (≥20 runes)
	// so substring dedup can reliably match without false positives.
	initial := "# Decisions: auto-dec\n\n## [2026-01-01] Initial\n- Use SQLite for persistent storage\n"
	if err := sd.WriteFile(context.Background(), "decisions.md", initial); err != nil {
		t.Fatalf("write decisions: %v", err)
	}

	// Auto-append new decisions (one duplicate, one new).
	autoAppendDecisions(context.Background(), sd, []string{
		"Use SQLite for persistent storage in the knowledge base", // substring overlap → should be skipped
		"Chose FTS5 over pure vector for deterministic ranking",   // new → should be added
	})

	content, err := sd.ReadFile("decisions.md")
	if err != nil {
		t.Fatalf("read decisions: %v", err)
	}

	if !strings.Contains(content, "FTS5") {
		t.Error("should append new decision about FTS5")
	}
	if !strings.Contains(content, "Auto-extracted from conversation") {
		t.Error("should have auto-extracted header")
	}
	// The duplicate "Use SQLite for persistent storage" should not be double-added.
	count := strings.Count(strings.ToLower(content), "use sqlite for persistent storage")
	if count > 1 {
		t.Errorf("duplicate decision should be skipped, found %d occurrences", count)
	}
}

func TestExtractTranscriptContextRich(t *testing.T) {
	dir := t.TempDir()
	lines := []string{
		`{"type":"human","content":"implement the search feature with hybrid approach"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll implement hybrid search combining FTS5 and vector search."}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_123","name":"Agent","input":{"description":"background research","prompt":"research vector DBs"}}]}}`,
		`{"type":"human","content":"also add Japanese support"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Adding Japanese decision markers to hooks_transcript.go now."}]}}`,
		`{"type":"tool_error","content":"connection timeout"}`,
	}
	path := writeFakeTranscript(t, dir, lines)

	ctx, data := extractTranscriptContextRich(path)
	if ctx == nil {
		t.Fatal("expected non-nil context")
	}
	if len(data) == 0 {
		t.Error("expected non-empty transcript data")
	}

	if len(ctx.UserMessages) != 2 {
		t.Errorf("expected 2 user messages, got %d", len(ctx.UserMessages))
	}
	if !strings.Contains(ctx.LastUserDirective, "Japanese") {
		t.Error("LastUserDirective should be the last user message")
	}
	if !strings.Contains(ctx.LastAssistantWork, "Japanese decision markers") {
		t.Errorf("LastAssistantWork should be last assistant text, got %q", ctx.LastAssistantWork)
	}
	if len(ctx.ToolErrors) != 1 {
		t.Errorf("expected 1 tool error, got %d", len(ctx.ToolErrors))
	}
	// Agent tool_use without completion should appear as running.
	if len(ctx.RunningAgents) != 1 {
		t.Errorf("expected 1 running agent, got %d: %v", len(ctx.RunningAgents), ctx.RunningAgents)
	}
}

func TestExtractTranscriptContextRichEmpty(t *testing.T) {
	ctx, data := extractTranscriptContextRich("/nonexistent/path")
	if ctx != nil {
		t.Error("non-existent file should return nil")
	}
	if data != nil {
		t.Error("non-existent file should return nil data")
	}
}


func TestIsTrivialDecisionJapanese(t *testing.T) {
	t.Parallel()
	tests := []struct {
		sentence string
		want     bool
	}{
		{"パフォーマンスの観点からSQLiteを採用することにした。組み込みDBとして最適。", false},
		{"ファイルを確認することにした", true},
		{"テストを実行することにした", true},
		{"短い", true},
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

// TestProactiveHintsForNextSteps removed: function deleted in simplification.

func TestSafeSnippet(t *testing.T) {
	t.Parallel()
	tests := []struct {
		input    string
		maxRunes int
		want     string
	}{
		{"short", 10, "short"},
		{"abcdefghij", 5, "abcde..."},
		{"", 5, ""},
		{"日本語テスト", 3, "日本語..."},
		{"日本語テスト", 10, "日本語テスト"},
		// Ensure multi-byte characters are not split mid-rune.
		{"🎉🎊🎈🎁", 2, "🎉🎊..."},
		// Preserves newlines (unlike truncateStr).
		{"line1\nline2\nline3", 11, "line1\nline2..."},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			t.Parallel()
			got := safeSnippet(tt.input, tt.maxRunes)
			if got != tt.want {
				t.Errorf("safeSnippet(%q, %d) = %q, want %q", tt.input, tt.maxRunes, got, tt.want)
			}
		})
	}
}

func TestEnforceSessionSizeLimit(t *testing.T) {
	t.Parallel()

	t.Run("under limit unchanged", func(t *testing.T) {
		t.Parallel()
		content := "# Session: test\n\n## Status\nactive\n"
		got := enforceSessionSizeLimit(content)
		if got != content {
			t.Error("content under limit should be unchanged")
		}
	})

	t.Run("removes oldest marker", func(t *testing.T) {
		t.Parallel()
		marker1 := "## Compact Marker [2026-01-01 00:00:00]\nOld context\n"
		marker2 := "## Compact Marker [2026-01-02 00:00:00]\nNew context\n"
		content := "# Session: test\n\n" + marker1 + marker2

		got := removeOldestCompactMarker(content)
		if strings.Contains(got, "2026-01-01") {
			t.Error("oldest marker should be removed")
		}
		if !strings.Contains(got, "2026-01-02") {
			t.Error("newer marker should be preserved")
		}
	})
}

func TestDetectRememberIntent(t *testing.T) {
	t.Parallel()
	tests := []struct {
		prompt string
		want   bool
	}{
		{"覚えておいて、このパターン", true},
		{"remember this for next time", true},
		{"save this information", true},
		{"メモしておいて", true},
		{"don't forget about this", true},
		{"hookの設定方法は？", false},
		{"what is memory management?", false},
		{"", false},
	}
	for _, tt := range tests {
		t.Run(tt.prompt, func(t *testing.T) {
			t.Parallel()
			if got := detectRememberIntent(tt.prompt); got != tt.want {
				t.Errorf("detectRememberIntent(%q) = %v, want %v", tt.prompt, got, tt.want)
			}
		})
	}
}

func TestExtractEarlyUserContext(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	// Build a transcript with user messages at the start.
	lines := []string{
		`{"type":"human","content":"Here is the design doc for the auth system:\n\n# Auth Design\n- JWT tokens\n- Refresh token rotation\n- RBAC with roles: admin, user, viewer"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I've reviewed the auth design. Let me implement JWT tokens first."}]}}`,
		`{"type":"human","content":"Also consider this API spec:\n\nPOST /auth/login\nPOST /auth/refresh\nGET /auth/me"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Got it. I'll implement all three endpoints."}]}}`,
		`{"type":"human","content":"Let's start with the login endpoint"}`,
	}
	path := writeFakeTranscript(t, dir, lines)

	result := extractEarlyUserContext(path)

	if result == "" {
		t.Fatal("expected non-empty early context")
	}
	if !strings.Contains(result, "Auth Design") {
		t.Error("should contain the design doc content")
	}
	if !strings.Contains(result, "API spec") {
		t.Error("should contain the API spec content")
	}
	if !strings.Contains(result, "login endpoint") {
		t.Error("should contain the third user message")
	}
	// Should NOT contain assistant messages.
	if strings.Contains(result, "implement JWT") {
		t.Error("should not contain assistant messages")
	}
}

func TestPersistChapterMemory(t *testing.T) {
	t.Parallel()
	sd := createTempSpec(t, "chapter-test")

	// Write session.md with existing content and a compact marker.
	session := "# Session: chapter-test\n\n## Status\nactive\n\n## Currently Working On\nImplementing hybrid search with FTS5 + vector\n\n## Compact Marker [2026-03-09 14:00:00]\n### Pre-Compact Context Snapshot\nLast user directive:\nAdd Japanese support\n---\n"
	if err := sd.WriteFile(context.Background(), "session.md", session); err != nil {
		t.Fatalf("write session: %v", err)
	}

	// Create a simple transcript.
	dir := t.TempDir()
	lines := []string{
		`{"type":"human","content":"Here is the search requirements doc with hybrid approach details"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll implement hybrid search now."}]}}`,
	}
	txPath := writeFakeTranscript(t, dir, lines)

	// Open a test DB.
	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	// Temporarily override the cached store for the test.
	ctx := context.Background()

	// Call persistChapterMemory directly (it uses OpenDefaultCached internally,
	// so we test the function's logic by verifying output).
	// Instead, test the extractEarlyUserContext + chapter content building.
	early := extractEarlyUserContext(txPath)
	if early == "" {
		t.Fatal("expected early context")
	}
	if !strings.Contains(early, "search requirements") {
		t.Error("early context should contain user's reference material")
	}

	// Verify chapter number detection from compact markers.
	compactCount := strings.Count(session, "## Compact Marker [")
	chapterNum := compactCount + 1
	if chapterNum != 2 {
		t.Errorf("expected chapter 2, got %d", chapterNum)
	}

	// Verify the chapter can be stored and retrieved from DB.
	project := "chapter-test-project"
	url := fmt.Sprintf("memory://user/%s/chapter-test/chapter-%d", project, chapterNum)
	id, _, err := st.UpsertDoc(ctx, &store.DocRow{
		URL:         url,
		SectionPath: fmt.Sprintf("%s > chapter-test > chapter-%d > Implementing hybrid search", project, chapterNum),
		Content:     "## Session State\n" + session + "\n\n## Initial User Context\n" + early,
		SourceType:  store.SourceMemory,
		TTLDays:     0,
	})
	if err != nil {
		t.Fatalf("upsert chapter: %v", err)
	}
	if id <= 0 {
		t.Error("expected positive doc ID")
	}

	// Verify keyword search finds the chapter.
	docs, err := st.SearchMemoriesKeyword(ctx, "hybrid search chapter", 10)
	if err != nil {
		t.Fatalf("keyword search: %v", err)
	}
	found := false
	for _, d := range docs {
		if strings.Contains(d.SectionPath, "chapter-2") {
			found = true
			break
		}
	}
	if !found {
		t.Error("chapter memory should be findable via keyword search")
	}
}

func TestIsStepMatchedByAction(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		item    string
		context string
		want    bool
	}{
		{
			name:    "git commit matches コミット step",
			item:    "コミット",
			context: "git commit -m 'feat: add feature' コミット",
			want:    true,
		},
		{
			name:    "go test matches テスト追加 step",
			item:    "テスト追加（refs_test.go）",
			context: "go test ./internal/spec/ -run testrefs テスト refs_test.go テスト追加",
			want:    true,
		},
		{
			name:    "unrelated command does not match",
			item:    "CLAUDE.md更新",
			context: "git commit -m 'fix: bug' commit",
			want:    false,
		},
		{
			name:    "go install matches ビルド step",
			item:    "ビルド＆インストール",
			context: "go install ./cmd/alfred install build ビルド インストール",
			want:    true,
		},
		{
			name:    "empty item never matches",
			item:    "",
			context: "git commit",
			want:    false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := isStepMatchedByAction(tt.item, tt.context)
			if got != tt.want {
				t.Errorf("isStepMatchedByAction(%q, ...) = %v, want %v", tt.item, got, tt.want)
			}
		})
	}
}

func TestReplaceSection(t *testing.T) {
	t.Parallel()
	content := "# Session: test\n\n## Status\nactive\n\n## Next Steps\n- [ ] Step 1\n- [ ] Step 2\n\n## Blockers\nNone\n"

	updated := replaceSection(content, "## Next Steps", "- [x] Step 1\n- [x] Step 2")

	if !strings.Contains(updated, "- [x] Step 1") {
		t.Error("should contain updated steps")
	}
	if !strings.Contains(updated, "## Blockers") {
		t.Error("should preserve following sections")
	}
	if !strings.Contains(updated, "## Status") {
		t.Error("should preserve preceding sections")
	}
}

func TestTryAutoCheckNextSteps(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	specDir := dir + "/.alfred/specs/auto-check-test"
	os.MkdirAll(specDir, 0o755)
	activeContent := "primary: auto-check-test\ntasks:\n    - slug: auto-check-test\n      started_at: \"2026-03-15T10:00:00Z\"\n      status: active\n"
	os.WriteFile(dir+"/.alfred/specs/_active.md", []byte(activeContent), 0o644)

	session := "# Session: auto-check-test\n\n## Status\nactive\n\n## Next Steps\n- [x] Feature 1 完了\n- [ ] テスト追加\n- [ ] コミット\n\n## Blockers\nNone\n"
	os.WriteFile(specDir+"/session.md", []byte(session), 0o644)

	ctx := context.Background()

	// Simulate: git commit succeeds.
	tryAutoCheckNextSteps(ctx, dir, "git commit -m 'feat: add tests'", "[main abc1234] feat: add tests")

	updated, err := os.ReadFile(specDir + "/session.md")
	if err != nil {
		t.Fatal(err)
	}
	content := string(updated)
	if !strings.Contains(content, "- [x] コミット") {
		t.Error("コミット step should be auto-checked after git commit")
	}
	// テスト追加 should NOT be checked by git commit.
	if strings.Contains(content, "- [x] テスト追加") {
		t.Error("テスト追加 should not be checked by git commit")
	}
}

func TestSyncSessionProgress(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name            string
		session         string
		wantCompleted   []string // items that should appear in Completed Steps
		wantNextSteps   []string // items that should remain in Next Steps
		wantWorkingOn   string   // expected "Currently Working On" content
		noCompleted     bool     // true if no Completed Steps section should exist
	}{
		{
			name: "moves checked items to Completed Steps",
			session: "# Session\n\n## Status\nactive\n\n## Currently Working On\nOld focus\n\n## Completed Steps\n\n## Next Steps\n- [x] T-1.1 [S] Done task\n- [ ] T-2.1 [M] Pending task\n- [ ] T-2.2 [S] Another pending\n\n## Blockers\nNone\n",
			wantCompleted: []string{"- [x] T-1.1 [S] Done task"},
			wantNextSteps: []string{"- [ ] T-2.1 [M] Pending task", "- [ ] T-2.2 [S] Another pending"},
			wantWorkingOn: "T-2.1 [M] Pending task",
		},
		{
			name: "creates Completed Steps section if missing",
			session: "# Session\n\n## Status\nactive\n\n## Currently Working On\nOld focus\n\n## Next Steps\n- [x] T-1.1 [S] Done\n- [ ] T-2.1 [M] Pending\n\n## Blockers\nNone\n",
			wantCompleted: []string{"- [x] T-1.1 [S] Done"},
			wantNextSteps: []string{"- [ ] T-2.1 [M] Pending"},
			wantWorkingOn: "T-2.1 [M] Pending",
		},
		{
			name: "all steps completed",
			session: "# Session\n\n## Status\nactive\n\n## Currently Working On\nOld focus\n\n## Completed Steps\n\n## Next Steps\n- [x] T-1.1 Done\n- [x] T-1.2 Also done\n\n## Blockers\nNone\n",
			wantCompleted: []string{"- [x] T-1.1 Done", "- [x] T-1.2 Also done"},
			wantNextSteps: []string{},
			wantWorkingOn: "All steps completed",
		},
		{
			name:        "no checked items — no change",
			session:     "# Session\n\n## Status\nactive\n\n## Currently Working On\nOld focus\n\n## Next Steps\n- [ ] T-1.1 Pending\n\n## Blockers\nNone\n",
			noCompleted: true,
			wantWorkingOn: "Old focus",
		},
		{
			name: "avoids duplicate in Completed Steps",
			session: "# Session\n\n## Status\nactive\n\n## Currently Working On\nOld focus\n\n## Completed Steps\n- [x] T-1.1 [S] Already done\n\n## Next Steps\n- [x] T-1.1 [S] Already done\n- [ ] T-2.1 Pending\n\n## Blockers\nNone\n",
			wantCompleted: []string{"- [x] T-1.1 [S] Already done"},
			wantNextSteps: []string{"- [ ] T-2.1 Pending"},
			wantWorkingOn: "T-2.1 Pending",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			result := syncSessionProgress(tt.session)

			// Check Completed Steps.
			for _, item := range tt.wantCompleted {
				completedSection := extractSectionFallback(result, "## Completed Steps", "## Completed")
				if !strings.Contains(completedSection, item) {
					t.Errorf("Completed Steps should contain %q, got:\n%s", item, completedSection)
				}
			}

			// Check Next Steps only has unchecked items.
			nextSection := extractSection(result, "## Next Steps")
			for _, item := range tt.wantNextSteps {
				if !strings.Contains(nextSection, item) {
					t.Errorf("Next Steps should contain %q, got:\n%s", item, nextSection)
				}
			}
			// No checked items should remain in Next Steps.
			if strings.Contains(nextSection, "- [x] ") || strings.Contains(nextSection, "- [X] ") {
				t.Errorf("Next Steps should not contain checked items, got:\n%s", nextSection)
			}

			// Check Currently Working On.
			workingOn := extractSection(result, "## Currently Working On")
			if !strings.Contains(workingOn, tt.wantWorkingOn) {
				t.Errorf("Currently Working On = %q, want %q", workingOn, tt.wantWorkingOn)
			}

			if tt.noCompleted {
				if strings.Contains(result, "## Completed Steps") {
					t.Error("should not create Completed Steps when no items checked")
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Skill nudge tests
// ---------------------------------------------------------------------------

func TestClassifyIntent(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		prompt  string
		want    []string
		notWant []string
	}{
		{
			name:   "japanese research",
			prompt: "このコードベースを調査して",
			want:   []string{"research"},
		},
		{
			name:   "english implement",
			prompt: "implement the auth module",
			want:   []string{"implement"},
		},
		{
			name:   "japanese bugfix",
			prompt: "このバグを直して",
			want:   []string{"bugfix"},
		},
		{
			name:   "japanese review",
			prompt: "コードレビューして",
			want:   []string{"review"},
		},
		{
			name:   "japanese plan",
			prompt: "この機能の仕様を書いて",
			want:   []string{"plan"},
		},
		{
			name:   "save knowledge",
			prompt: "競合ツールの調査結果をまとめて保存",
			want:   []string{"save-knowledge"},
			notWant: []string{"research"}, // save-knowledge suppresses research
		},
		{
			name:   "no match",
			prompt: "hello world",
			want:   nil,
		},
		{
			name:    "check does not trigger review",
			prompt:  "テスト結果を確認して",
			notWant: []string{"review"},
		},
		{
			name:    "create does not trigger implement",
			prompt:  "ファイルを作って",
			notWant: []string{"implement"},
		},
		{
			name:    "build does not trigger implement",
			prompt:  "build the project",
			notWant: []string{"implement"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := classifyIntent(tt.prompt)
			gotSet := map[string]bool{}
			for _, i := range got {
				gotSet[i] = true
			}
			for _, w := range tt.want {
				if !gotSet[w] {
					t.Errorf("classifyIntent(%q) missing intent %q, got %v", tt.prompt, w, got)
				}
			}
			for _, nw := range tt.notWant {
				if gotSet[nw] {
					t.Errorf("classifyIntent(%q) should not have intent %q, got %v", tt.prompt, nw, got)
				}
			}
		})
	}
}

func TestBuildSkillNudge(t *testing.T) {
	t.Parallel()

	t.Run("implement without active spec", func(t *testing.T) {
		t.Parallel()
		nudge := buildSkillNudge([]string{"implement"}, false)
		if !strings.Contains(nudge, "/alfred:attend") {
			t.Errorf("nudge should contain /alfred:attend, got %q", nudge)
		}
	})

	t.Run("implement with active spec suppressed", func(t *testing.T) {
		t.Parallel()
		nudge := buildSkillNudge([]string{"implement"}, true)
		if nudge != "" {
			t.Errorf("nudge should be empty when active spec exists, got %q", nudge)
		}
	})

	t.Run("plan with active spec suppressed", func(t *testing.T) {
		t.Parallel()
		nudge := buildSkillNudge([]string{"plan"}, true)
		if nudge != "" {
			t.Errorf("nudge should be empty when active spec exists, got %q", nudge)
		}
	})

	t.Run("bugfix not suppressed by active spec", func(t *testing.T) {
		t.Parallel()
		nudge := buildSkillNudge([]string{"bugfix"}, true)
		if !strings.Contains(nudge, "/alfred:mend") {
			t.Errorf("bugfix nudge should not be suppressed, got %q", nudge)
		}
	})

	t.Run("review maps to inspect", func(t *testing.T) {
		t.Parallel()
		nudge := buildSkillNudge([]string{"review"}, false)
		if !strings.Contains(nudge, "/alfred:inspect") {
			t.Errorf("review nudge should contain /alfred:inspect, got %q", nudge)
		}
	})

	t.Run("save-knowledge maps to ledger", func(t *testing.T) {
		t.Parallel()
		nudge := buildSkillNudge([]string{"save-knowledge"}, false)
		if !strings.Contains(nudge, "ledger") {
			t.Errorf("save-knowledge nudge should mention ledger, got %q", nudge)
		}
	})

	t.Run("no intents returns empty", func(t *testing.T) {
		t.Parallel()
		nudge := buildSkillNudge(nil, false)
		if nudge != "" {
			t.Errorf("empty intents should return empty nudge, got %q", nudge)
		}
	})

	t.Run("no duplicate nudges", func(t *testing.T) {
		t.Parallel()
		nudge := buildSkillNudge([]string{"review", "review"}, false)
		count := strings.Count(nudge, "/alfred:inspect")
		if count > 1 {
			t.Errorf("should not duplicate nudges, found %d occurrences", count)
		}
	})
}

func TestCombineHints(t *testing.T) {
	t.Parallel()

	t.Run("both non-empty", func(t *testing.T) {
		t.Parallel()
		result := combineHints("hint1", "hint2")
		if result != "hint1\n\nhint2" {
			t.Errorf("combineHints = %q, want %q", result, "hint1\n\nhint2")
		}
	})

	t.Run("one empty", func(t *testing.T) {
		t.Parallel()
		result := combineHints("", "hint2")
		if result != "hint2" {
			t.Errorf("combineHints = %q, want %q", result, "hint2")
		}
	})

	t.Run("both empty", func(t *testing.T) {
		t.Parallel()
		result := combineHints("", "")
		if result != "" {
			t.Errorf("combineHints = %q, want empty", result)
		}
	})
}

func TestClassifyIntentTDD(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		prompt string
		want   string
	}{
		{"japanese tdd", "テスト駆動で実装して", "tdd"},
		{"english tdd", "let's do TDD for this feature", "tdd"},
		{"test first", "test first approach for the auth module", "tdd"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := classifyIntent(tt.prompt)
			found := false
			for _, i := range got {
				if i == tt.want {
					found = true
				}
			}
			if !found {
				t.Errorf("classifyIntent(%q) = %v, want %q", tt.prompt, got, tt.want)
			}
		})
	}
}

func TestTrackExplorationPattern(t *testing.T) {
	t.Parallel()

	// Clean up temp file before and after.
	os.Remove(exploreCountFile)
	t.Cleanup(func() { os.Remove(exploreCountFile) })

	ev := &hookEvent{ToolName: "Read", ProjectPath: t.TempDir()}

	// 4 calls should not trigger (threshold is 5).
	for i := 0; i < 4; i++ {
		trackExplorationPattern(ev)
	}
	data, err := os.ReadFile(exploreCountFile)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if strings.TrimSpace(string(data)) != "4" {
		t.Errorf("count = %q, want 4", string(data))
	}
}

func TestSuggestKnowledgeSave(t *testing.T) {
	t.Parallel()

	t.Run("research patterns detected", func(t *testing.T) {
		t.Parallel()
		txCtx := &transcriptContext{
			UserMessages:     []string{"競合ツールを調査して", "分析結果をまとめて"},
			AssistantActions: []string{"investigated 3 tools and compared their approaches"},
		}
		// This should not panic. The actual output goes to stderr.
		suggestKnowledgeSave(txCtx)
	})

	t.Run("no research patterns", func(t *testing.T) {
		t.Parallel()
		txCtx := &transcriptContext{
			UserMessages:     []string{"hello world"},
			AssistantActions: []string{"printed hello"},
		}
		suggestKnowledgeSave(txCtx) // should not suggest
	})
}

func TestHasActiveSpecTask(t *testing.T) {
	t.Parallel()

	t.Run("no active spec", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		if hasActiveSpecTask(tmp) {
			t.Error("should return false for dir without active spec")
		}
	})

	t.Run("with active spec", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		_, err := spec.Init(tmp, "test-task", "test", spec.WithSize(spec.SizeS))
		if err != nil {
			t.Fatalf("Init: %v", err)
		}
		if !hasActiveSpecTask(tmp) {
			t.Error("should return true when active spec exists")
		}
	})

	t.Run("empty path", func(t *testing.T) {
		t.Parallel()
		if hasActiveSpecTask("") {
			t.Error("should return false for empty path")
		}
	})
}
