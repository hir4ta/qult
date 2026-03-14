package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSpecAlignmentNudge(t *testing.T) {
	t.Run("no active spec returns empty", func(t *testing.T) {
		dir := t.TempDir()
		nudge := specAlignmentNudge(dir)
		if nudge != "" {
			t.Fatalf("expected empty nudge, got: %s", nudge)
		}
	})

	t.Run("returns full nudge on first show", func(t *testing.T) {
		dir := t.TempDir()
		setupSpecForAlignment(t, dir, "align-task",
			`# Requirements: align-task

## Goal
Improve test coverage to 50% or above

## Success Criteria
- [ ] Add unit tests for store package
- [x] Add integration tests for hooks
- [ ] Reach 50% coverage threshold
`,
			`# Session: align-task

## Status
active

## Currently Working On
Refactoring hooks_prompt.go for better testability
`)

		nudge := specAlignmentNudge(dir)
		if nudge == "" {
			t.Fatal("expected non-empty nudge")
		}
		if !strings.Contains(nudge, "Spec alignment reminder") {
			t.Fatalf("expected alignment reminder header, got: %s", nudge)
		}
		if !strings.Contains(nudge, "Improve test coverage") {
			t.Fatalf("expected goal in nudge, got: %s", nudge)
		}
		// Should show only unchecked criteria.
		if !strings.Contains(nudge, "Add unit tests") {
			t.Fatalf("expected open criteria, got: %s", nudge)
		}
		if strings.Contains(nudge, "integration tests") {
			t.Fatalf("should not include checked criteria, got: %s", nudge)
		}
		if !strings.Contains(nudge, "spec may need updating") {
			t.Fatalf("expected butler-tone suggestion, got: %s", nudge)
		}
	})

	t.Run("acknowledged spec returns empty", func(t *testing.T) {
		dir := t.TempDir()
		setupSpecForAlignment(t, dir, "ack-task",
			`# Requirements: ack-task

## Goal
Some goal

## Success Criteria
- [ ] Something
`,
			`# Session: ack-task

## Status
active

## Currently Working On
Working
<!-- alignment-ack -->
`)

		nudge := specAlignmentNudge(dir)
		if nudge != "" {
			t.Fatalf("expected empty nudge for acknowledged spec, got: %s", nudge)
		}
	})

	t.Run("progressive cooldown suppresses after max shows", func(t *testing.T) {
		dir := t.TempDir()
		setupSpecForAlignment(t, dir, "cool-task",
			`# Requirements: cool-task

## Goal
Some goal

## Success Criteria
- [ ] Something
`,
			`# Session: cool-task

## Status
active

## Currently Working On
Working
<!-- alignment-shown: 2 -->
`)

		nudge := specAlignmentNudge(dir)
		if nudge != "" {
			t.Fatalf("expected empty nudge after cooldown, got: %s", nudge)
		}
	})

	t.Run("second show returns summary", func(t *testing.T) {
		dir := t.TempDir()
		setupSpecForAlignment(t, dir, "sum-task",
			`# Requirements: sum-task

## Goal
Build feature X

## Success Criteria
- [ ] Implement X
`,
			`# Session: sum-task

## Status
active

## Currently Working On
Working
<!-- alignment-shown: 1 -->
`)

		nudge := specAlignmentNudge(dir)
		if nudge == "" {
			t.Fatal("expected summary nudge on second show")
		}
		if !strings.Contains(nudge, "Spec goals unchanged") {
			t.Fatalf("expected summary format, got: %s", nudge)
		}
		if strings.Contains(nudge, "Spec alignment reminder") {
			t.Fatalf("should not have full format on second show, got: %s", nudge)
		}
	})
}

func TestSpecAlignmentNudgeGoalOnly(t *testing.T) {
	dir := t.TempDir()
	setupSpecForAlignment(t, dir, "goal-only",
		`# Requirements: goal-only

## Goal
Build feature X
`,
		`# Session: goal-only

## Status
active

## Currently Working On
Working
`)

	nudge := specAlignmentNudge(dir)
	if nudge == "" {
		t.Fatal("expected nudge with goal only (no criteria)")
	}
	if !strings.Contains(nudge, "Build feature X") {
		t.Fatalf("expected goal in nudge, got: %s", nudge)
	}
}

func TestCountAlignmentShown(t *testing.T) {
	tests := []struct {
		name    string
		session string
		want    int
	}{
		{"no marker", "# Session\n## Status\nactive", 0},
		{"marker with 1", "some content\n<!-- alignment-shown: 1 -->\nmore", 1},
		{"marker with 3", "<!-- alignment-shown: 3 -->", 3},
		{"marker with 0", "<!-- alignment-shown: 0 -->", 0},
		{"multiple markers takes last", "<!-- alignment-shown: 1 -->\n<!-- alignment-shown: 5 -->", 5},
		{"malformed marker", "<!-- alignment-shown: abc -->", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := countAlignmentShown(tt.session)
			if got != tt.want {
				t.Fatalf("countAlignmentShown() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestFormatAlignmentShown(t *testing.T) {
	got := formatAlignmentShown(3)
	want := "<!-- alignment-shown: 3 -->"
	if got != want {
		t.Fatalf("formatAlignmentShown(3) = %q, want %q", got, want)
	}
}

func TestExtractOpenCriteria(t *testing.T) {
	criteria := `- [x] Done item
- [ ] Open item 1
- [ ] Open item 2
- [x] Another done
`
	open := extractOpenCriteria(criteria)
	if len(open) != 2 {
		t.Fatalf("expected 2 open criteria, got %d", len(open))
	}
	if !strings.Contains(open[0], "Open item 1") {
		t.Fatalf("expected first open item, got: %s", open[0])
	}
}

// setupSpecForAlignment creates a spec with requirements.md and session.md.
func setupSpecForAlignment(t *testing.T, projectDir, taskSlug, requirements, session string) {
	t.Helper()
	specDir := filepath.Join(projectDir, ".alfred", "specs", taskSlug)
	if err := os.MkdirAll(specDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(specDir, "requirements.md"), []byte(requirements), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(specDir, "session.md"), []byte(session), 0o644); err != nil {
		t.Fatal(err)
	}
	// Write _active.md
	activeContent := "primary: " + taskSlug + "\ntasks:\n  - slug: " + taskSlug + "\n"
	activeDir := filepath.Join(projectDir, ".alfred", "specs")
	if err := os.WriteFile(filepath.Join(activeDir, "_active.md"), []byte(activeContent), 0o644); err != nil {
		t.Fatal(err)
	}
}
