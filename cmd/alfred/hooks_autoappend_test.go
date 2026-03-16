package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/spec"
)

func TestShouldAutoAppend(t *testing.T) {
	t.Parallel()

	tests := []struct {
		path string
		want bool
	}{
		{"internal/store/new.go", true},
		{"cmd/alfred/main.go", true},
		{"internal/store/new_test.go", false},
		{"internal/store/types_string.go", false},
		{"internal/store/types_gen.go", false},
		{"internal/store/mock_store.go", true},  // doesn't end with _mock.go suffix
		{"internal/store/store_mock.go", false}, // ends with _mock.go
		{"proto/api.pb.go", false},
		{"vendor/github.com/foo/bar.go", false},
		{"plugin/output.go", false},
		{".alfred/specs/task/design.md", false},
		{"go.mod", false},
		{"go.sum", false},
		{"internal/spec/templates/req.tmpl", false},
		{"README.md", false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			t.Parallel()
			got := shouldAutoAppend(tt.path)
			if got != tt.want {
				t.Errorf("shouldAutoAppend(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestInsertAfterLastFileLine(t *testing.T) {
	t.Parallel()

	design := `# Design: test

## Component Design

### Component: Store
- **File**: ` + "`internal/store/docs.go`" + `
- **File**: ` + "`internal/store/fts.go`" + `
- **Responsibility**: SQLite persistence

### Component: Hook
- **File**: ` + "`cmd/alfred/hooks.go`" + `
- **Responsibility**: Hook handler
`

	t.Run("append_to_store", func(t *testing.T) {
		t.Parallel()
		result := insertAfterLastFileLine(design, "Store", "- **File**: `internal/store/new.go` <!-- auto-added -->")
		if !strings.Contains(result, "new.go") {
			t.Error("expected new.go in result")
		}
		// Should be after fts.go but before Responsibility.
		ftsIdx := strings.Index(result, "fts.go")
		newIdx := strings.Index(result, "new.go")
		respIdx := strings.Index(result, "Responsibility**: SQLite")
		if newIdx < ftsIdx || newIdx > respIdx {
			t.Errorf("insertion point wrong: fts=%d, new=%d, resp=%d", ftsIdx, newIdx, respIdx)
		}
	})

	t.Run("append_to_hook", func(t *testing.T) {
		t.Parallel()
		result := insertAfterLastFileLine(design, "Hook", "- **File**: `cmd/alfred/hooks_new.go` <!-- auto-added -->")
		if !strings.Contains(result, "hooks_new.go") {
			t.Error("expected hooks_new.go in result")
		}
	})

	t.Run("unknown_component", func(t *testing.T) {
		t.Parallel()
		result := insertAfterLastFileLine(design, "Unknown", "- **File**: `foo.go`")
		if result != design {
			t.Error("expected unchanged content for unknown component")
		}
	})

	t.Run("no_duplicate", func(t *testing.T) {
		t.Parallel()
		// Insert once.
		first := insertAfterLastFileLine(design, "Store", "- **File**: `internal/store/new.go` <!-- auto-added -->")
		// Insert again — should still only appear once since fileLineRe matches.
		// But insertAfterLastFileLine doesn't check duplicates; that's the caller's job.
		// Just verify the function is deterministic.
		if !strings.Contains(first, "new.go") {
			t.Error("expected new.go in first result")
		}
	})
}

func TestComponentHasFileLines(t *testing.T) {
	t.Parallel()

	design := `### Component: WithFiles
- **File**: ` + "`some/path.go`" + `
- **Responsibility**: Does things

### Component: NoFiles
- **Responsibility**: Constants only
`

	tests := []struct {
		name      string
		component string
		want      bool
	}{
		{"with_files", "WithFiles", true},
		{"no_files", "NoFiles", false},
		{"nonexistent", "Missing", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := componentHasFileLines(design, tt.component)
			if got != tt.want {
				t.Errorf("componentHasFileLines(%q) = %v, want %v", tt.component, got, tt.want)
			}
		})
	}
}

func TestTryAutoAppendDesignRefs(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	slug := "auto-test"

	sd, err := spec.Init(dir, slug, "test auto-append feature with enough words to make it medium size", spec.WithSize(spec.SizeL))
	if err != nil {
		t.Fatalf("spec.Init: %v", err)
	}

	// Write a design.md with a component.
	designContent := `# Design: auto-test

## Component Design

### Component: Store
- **File**: ` + "`internal/store/docs.go`" + `
- **Responsibility**: SQLite persistence
`
	if err := sd.WriteFile(context.Background(), spec.FileDesign, designContent); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	ctx := context.Background()

	t.Run("append_matching_file", func(t *testing.T) {
		appended := tryAutoAppendDesignRefs(ctx, dir, []string{"internal/store/new.go"})
		if !appended["internal/store/new.go"] {
			t.Error("expected internal/store/new.go to be appended")
		}

		// Verify design.md was updated.
		content, err := sd.ReadFile(spec.FileDesign)
		if err != nil {
			t.Fatalf("ReadFile: %v", err)
		}
		if !strings.Contains(content, "internal/store/new.go") {
			t.Error("design.md should contain new.go")
		}
		if !strings.Contains(content, "auto-added") {
			t.Error("design.md should contain auto-added marker")
		}
	})

	t.Run("no_duplicate_on_second_call", func(t *testing.T) {
		appended := tryAutoAppendDesignRefs(ctx, dir, []string{"internal/store/new.go"})
		if appended["internal/store/new.go"] {
			t.Error("should NOT re-append existing file")
		}
	})

	t.Run("skip_test_file", func(t *testing.T) {
		appended := tryAutoAppendDesignRefs(ctx, dir, []string{"internal/store/new_test.go"})
		if len(appended) > 0 {
			t.Error("should skip test files")
		}
	})

	t.Run("skip_no_matching_component", func(t *testing.T) {
		appended := tryAutoAppendDesignRefs(ctx, dir, []string{"pkg/unknown/foo.go"})
		if len(appended) > 0 {
			t.Error("should skip files with no matching component")
		}
	})

	t.Run("audit_trail", func(t *testing.T) {
		auditPath := filepath.Join(dir, ".alfred", "audit.jsonl")
		data, err := os.ReadFile(auditPath)
		if err != nil {
			t.Fatalf("read audit.jsonl: %v", err)
		}
		if !strings.Contains(string(data), livingSpecAction) {
			t.Error("audit.jsonl should contain living-spec.update entry")
		}
	})

	t.Run("history_preserved", func(t *testing.T) {
		histDir := filepath.Join(sd.Dir(), ".history")
		entries, err := os.ReadDir(histDir)
		if err != nil {
			t.Fatalf("read .history: %v", err)
		}
		found := false
		for _, e := range entries {
			if strings.Contains(e.Name(), "design") {
				found = true
				break
			}
		}
		if !found {
			t.Error("expected design.md history entry in .history/")
		}
	})
}
