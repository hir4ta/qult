package mcpserver

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/store"
)

func TestExtractMemoryFileRefs(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name         string
		content      string
		wantFiles    []string
		wantPatterns []string
	}{
		{
			name:         "empty content",
			content:      "",
			wantFiles:    nil,
			wantPatterns: nil,
		},
		{
			name:         "go file path",
			content:      "Always use `escapeLIKEPrefix()` in internal/store/docs.go for safety",
			wantFiles:    []string{"internal/store/docs.go"},
			wantPatterns: []string{"escapeLIKEPrefix()"},
		},
		{
			name:         "multiple paths",
			content:      "Modified cmd/alfred/hooks.go and internal/spec/spec.go to add drift detection",
			wantFiles:    []string{"cmd/alfred/hooks.go", "internal/spec/spec.go"},
			wantPatterns: nil,
		},
		{
			name:         "backtick patterns",
			content:      "Use `Store.UpsertDoc` and `ContentHashOf` for all writes",
			wantFiles:    nil,
			wantPatterns: []string{"Store.UpsertDoc", "ContentHashOf"},
		},
		{
			name:         "no extractable content",
			content:      "Always review code before committing",
			wantFiles:    nil,
			wantPatterns: nil,
		},
		{
			name:    "skip short backtick content",
			content: "Use `go` for builds",
			// "go" is too short (< 3 chars)
			wantPatterns: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			files, patterns := extractMemoryFileRefs(tt.content)
			if len(files) != len(tt.wantFiles) {
				t.Errorf("files: got %v, want %v", files, tt.wantFiles)
			} else {
				for i, f := range tt.wantFiles {
					if files[i] != f {
						t.Errorf("files[%d] = %q, want %q", i, files[i], f)
					}
				}
			}
			if len(patterns) != len(tt.wantPatterns) {
				t.Errorf("patterns: got %v, want %v", patterns, tt.wantPatterns)
			} else {
				for i, p := range tt.wantPatterns {
					if patterns[i] != p {
						t.Errorf("patterns[%d] = %q, want %q", i, patterns[i], p)
					}
				}
			}
		})
	}
}

func TestCheckConvention(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()

	// Create a Go file with known content.
	cmdDir := filepath.Join(tmp, "cmd", "alfred")
	os.MkdirAll(cmdDir, 0o755)
	os.WriteFile(filepath.Join(cmdDir, "main.go"), []byte("package main\n\nfunc escapeLIKEPrefix() {}\n"), 0o644)

	tests := []struct {
		name         string
		fileRefs     []string
		codePatterns []string
		wantDrifted  bool
		wantEvidence string
	}{
		{
			name:        "existing file",
			fileRefs:    []string{"cmd/alfred/main.go"},
			wantDrifted: false,
		},
		{
			name:         "missing file",
			fileRefs:     []string{"internal/old/removed.go"},
			wantDrifted:  true,
			wantEvidence: "file not found: internal/old/removed.go",
		},
		{
			name:         "existing pattern",
			codePatterns: []string{"escapeLIKEPrefix"},
			wantDrifted:  false,
		},
		{
			name:         "missing pattern",
			codePatterns: []string{"renamedFunction"},
			wantDrifted:  true,
			wantEvidence: "pattern not found: renamedFunction",
		},
		{
			name: "no refs",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			drifted, evidence := checkConvention(tmp, tt.fileRefs, tt.codePatterns)
			if drifted != tt.wantDrifted {
				t.Errorf("drifted = %v, want %v", drifted, tt.wantDrifted)
			}
			if tt.wantEvidence != "" && evidence != tt.wantEvidence {
				t.Errorf("evidence = %q, want %q", evidence, tt.wantEvidence)
			}
		})
	}
}

func TestRecallAuditConventions_ExplicitProjectPath(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	// When project_path is not set, resolveProjectPath falls back to cwd.
	// Just verify the action works without crashing.
	res, err := handler(context.Background(), newRequest(map[string]any{
		"action":       "audit-conventions",
		"project_path": t.TempDir(),
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}
}

func TestRecallAuditConventions_Empty(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
	handler := recallHandler(st, nil)

	tmp := t.TempDir()
	res, err := handler(context.Background(), newRequest(map[string]any{
		"action":       "audit-conventions",
		"project_path": tmp,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if m["total_checked"].(float64) != 0 {
		t.Errorf("total_checked = %v, want 0", m["total_checked"])
	}
}

func TestRecallAuditConventions_WithMemories(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	// Insert a pattern memory that references a file.
	tmp := t.TempDir()
	cmdDir := filepath.Join(tmp, "cmd", "alfred")
	os.MkdirAll(cmdDir, 0o755)
	os.WriteFile(filepath.Join(cmdDir, "main.go"), []byte("package main\n"), 0o644)

	ctx := context.Background()
	// Insert a pattern memory referencing an existing file.
	_, _, err := st.UpsertKnowledge(ctx, &store.KnowledgeRow{
		FilePath:    "memory://test/1",
		Title:       "test > pattern > existing file",
		Content:     "Hook handler at cmd/alfred/main.go handles events",
		SubType:     store.SubTypePattern,
		ProjectPath: tmp,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Insert a rule memory referencing a non-existent file.
	_, _, err = st.UpsertKnowledge(ctx, &store.KnowledgeRow{
		FilePath:    "memory://test/2",
		Title:       "test > rule > deleted file",
		Content:     "Always check internal/old/removed.go for compatibility",
		SubType:     store.SubTypeRule,
		ProjectPath: tmp,
	})
	if err != nil {
		t.Fatal(err)
	}

	handler := recallHandler(st, nil)
	res, err := handler(ctx, newRequest(map[string]any{
		"action":       "audit-conventions",
		"project_path": tmp,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", resultText(t, res))
	}

	m := resultJSON(t, res)
	if m["drifted"].(float64) < 1 {
		t.Errorf("expected at least 1 drifted, got %v", m["drifted"])
	}
}

func TestAggregateDriftStats(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	os.MkdirAll(filepath.Join(tmp, ".alfred"), 0o755)

	// No audit log — should return nil.
	stats := aggregateDriftStats(tmp)
	if stats != nil {
		t.Errorf("expected nil stats, got %v", stats)
	}

	// Write some drift audit entries.
	auditFile := filepath.Join(tmp, ".alfred", "audit.jsonl")
	entries := []string{
		`{"timestamp":"2026-03-16T00:00:00Z","action":"drift.spec","target":"task-a","detail":"{\"type\":\"spec-drift\",\"severity\":\"warning\",\"resolution\":\"unresolved\"}"}`,
		`{"timestamp":"2026-03-16T00:00:01Z","action":"drift.convention","target":"memory:42","detail":"{\"type\":\"convention-drift\",\"severity\":\"warning\",\"resolution\":\"unresolved\"}"}`,
		`{"timestamp":"2026-03-16T00:00:02Z","action":"drift.spec","target":"task-a","detail":"{\"type\":\"spec-drift\",\"severity\":\"critical\",\"resolution\":\"acknowledged\"}"}`,
		`{"timestamp":"2026-03-16T00:00:03Z","action":"spec.init","target":"other","detail":"not a drift event"}`,
	}
	os.WriteFile(auditFile, []byte(joinLines(entries)), 0o644)

	stats = aggregateDriftStats(tmp)
	if stats == nil {
		t.Fatal("expected non-nil stats")
	}
	if stats["total"].(int) != 3 {
		t.Errorf("total = %v, want 3", stats["total"])
	}
	if stats["unresolved"].(int) != 2 {
		t.Errorf("unresolved = %v, want 2", stats["unresolved"])
	}
}

func joinLines(lines []string) string {
	result := ""
	for _, l := range lines {
		result += l + "\n"
	}
	return result
}
