package spec

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseRefs(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    int
		slugs   []string
	}{
		{
			name:    "no refs",
			content: "some markdown without references",
			want:    0,
		},
		{
			name:    "single spec ref",
			content: "see @spec:auth-refactor for details",
			want:    1,
			slugs:   []string{"auth-refactor"},
		},
		{
			name:    "ref with file",
			content: "based on @spec:auth-refactor/design.md",
			want:    1,
			slugs:   []string{"auth-refactor"},
		},
		{
			name:    "multiple refs",
			content: "see @spec:auth-refactor and @spec:api-v2/requirements.md",
			want:    2,
			slugs:   []string{"auth-refactor", "api-v2"},
		},
		{
			name:    "duplicate refs deduplicated",
			content: "@spec:auth-refactor mentioned twice: @spec:auth-refactor",
			want:    1,
			slugs:   []string{"auth-refactor"},
		},
		{
			name:    "ref in markdown context",
			content: "## Design\nThis builds on @spec:base-system/design.md architecture.",
			want:    1,
			slugs:   []string{"base-system"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			refs := ParseRefs(tt.content)
			if len(refs) != tt.want {
				t.Errorf("ParseRefs() got %d refs, want %d", len(refs), tt.want)
			}
			for i, slug := range tt.slugs {
				if i < len(refs) && refs[i].TaskSlug != slug {
					t.Errorf("refs[%d].TaskSlug = %q, want %q", i, refs[i].TaskSlug, slug)
				}
			}
		})
	}
}

func TestParseRefsFileField(t *testing.T) {
	refs := ParseRefs("@spec:foo/design.md and @spec:bar")
	if len(refs) != 2 {
		t.Fatalf("expected 2 refs, got %d", len(refs))
	}
	if refs[0].File != "design.md" {
		t.Errorf("refs[0].File = %q, want %q", refs[0].File, "design.md")
	}
	if refs[1].File != "" {
		t.Errorf("refs[1].File = %q, want empty", refs[1].File)
	}
}

func TestParseRefsHyphenatedFile(t *testing.T) {
	t.Parallel()
	refs := ParseRefs("See @spec:my-task/test-specs.md for details")
	if len(refs) != 1 {
		t.Fatalf("ParseRefs() = %d refs, want 1", len(refs))
	}
	if refs[0].File != "test-specs.md" {
		t.Errorf("refs[0].File = %q, want %q", refs[0].File, "test-specs.md")
	}
	if refs[0].TaskSlug != "my-task" {
		t.Errorf("refs[0].TaskSlug = %q, want %q", refs[0].TaskSlug, "my-task")
	}
}

func TestResolveRefs(t *testing.T) {
	tmp := t.TempDir()
	specsDir := filepath.Join(tmp, ".alfred", "specs")

	// Create a spec directory with one file.
	taskDir := filepath.Join(specsDir, "existing-task")
	if err := os.MkdirAll(taskDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taskDir, "design.md"), []byte("# Design"), 0o644); err != nil {
		t.Fatal(err)
	}

	refs := []SpecRef{
		{TaskSlug: "existing-task", File: "design.md"},
		{TaskSlug: "existing-task", File: "missing.md"},
		{TaskSlug: "deleted-task", File: ""},
	}

	resolved := ResolveRefs(tmp, refs)
	if len(resolved) != 3 {
		t.Fatalf("expected 3 resolved, got %d", len(resolved))
	}

	// Existing task + existing file.
	if !resolved[0].Exists {
		t.Error("resolved[0] should exist")
	}

	// Existing task + missing file.
	if resolved[1].Exists {
		t.Error("resolved[1] should not exist")
	}
	if resolved[1].DanglingReason != "file not found" {
		t.Errorf("resolved[1].DanglingReason = %q", resolved[1].DanglingReason)
	}

	// Deleted task.
	if resolved[2].Exists {
		t.Error("resolved[2] should not exist")
	}
	if resolved[2].DanglingReason != "spec deleted" {
		t.Errorf("resolved[2].DanglingReason = %q", resolved[2].DanglingReason)
	}
}

func TestCollectOutgoing(t *testing.T) {
	tmp := t.TempDir()
	specsDir := filepath.Join(tmp, ".alfred", "specs")

	// Create task-a with a reference to task-b.
	taskA := filepath.Join(specsDir, "task-a")
	if err := os.MkdirAll(taskA, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(taskA, "design.md"), []byte("see @spec:task-b/requirements.md"), 0o644)
	os.WriteFile(filepath.Join(taskA, "requirements.md"), []byte("# Req"), 0o644)
	os.WriteFile(filepath.Join(taskA, "decisions.md"), []byte("# Dec"), 0o644)
	os.WriteFile(filepath.Join(taskA, "session.md"), []byte("# Sess"), 0o644)

	out := CollectOutgoing(tmp, "task-a")
	if len(out) != 1 {
		t.Fatalf("expected 1 outgoing, got %d", len(out))
	}
	if out[0].Target != "task-b/requirements.md" {
		t.Errorf("target = %q, want %q", out[0].Target, "task-b/requirements.md")
	}
	if out[0].FromFile != "design.md" {
		t.Errorf("from_file = %q, want %q", out[0].FromFile, "design.md")
	}
}

func TestCollectIncoming(t *testing.T) {
	tmp := t.TempDir()
	specsDir := filepath.Join(tmp, ".alfred", "specs")

	// Create task-a referencing task-b.
	taskA := filepath.Join(specsDir, "task-a")
	os.MkdirAll(taskA, 0o755)
	os.WriteFile(filepath.Join(taskA, "requirements.md"), []byte("depends on @spec:task-b"), 0o644)
	os.WriteFile(filepath.Join(taskA, "design.md"), []byte("# Design"), 0o644)
	os.WriteFile(filepath.Join(taskA, "decisions.md"), []byte("# Dec"), 0o644)
	os.WriteFile(filepath.Join(taskA, "session.md"), []byte("# Sess"), 0o644)

	// Create task-b (the target).
	taskB := filepath.Join(specsDir, "task-b")
	os.MkdirAll(taskB, 0o755)
	os.WriteFile(filepath.Join(taskB, "requirements.md"), []byte("# Req"), 0o644)

	incoming := CollectIncoming(tmp, "task-b")
	if len(incoming) != 1 {
		t.Fatalf("expected 1 incoming, got %d", len(incoming))
	}
	if incoming[0].Source != "task-a/requirements.md" {
		t.Errorf("source = %q, want %q", incoming[0].Source, "task-a/requirements.md")
	}
}
