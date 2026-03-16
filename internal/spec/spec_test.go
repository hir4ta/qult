package spec

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInitCreatesAllFiles(t *testing.T) {
	tmp := t.TempDir()
	sd, err := Init(tmp, "add-auth", "Add authentication support")
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	// Check all 7 spec files exist
	for _, f := range AllFiles {
		path := sd.FilePath(f)
		if _, err := os.Stat(path); err != nil {
			t.Errorf("expected file %s to exist, got error: %v", f, err)
		}
	}

	// Check _active.md exists and contains correct slug
	slug, err := ReadActive(tmp)
	if err != nil {
		t.Fatalf("ReadActive failed: %v", err)
	}
	if slug != "add-auth" {
		t.Errorf("expected slug 'add-auth', got %q", slug)
	}

	// Check requirements.md contains description
	content, err := sd.ReadFile(FileRequirements)
	if err != nil {
		t.Fatalf("ReadFile requirements failed: %v", err)
	}
	if !strings.Contains(content, "Add authentication support") {
		t.Error("requirements.md should contain the description")
	}
	if !strings.Contains(content, "# Requirements: add-auth") {
		t.Error("requirements.md should contain the task slug header")
	}
}

func TestAppendFile(t *testing.T) {
	tmp := t.TempDir()
	sd, err := Init(tmp, "test-task", "Test task")
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	appendContent := "\n## New Decision\n- **Chosen:** Go\n"
	if err := sd.AppendFile(context.Background(), FileDecisions, appendContent); err != nil {
		t.Fatalf("AppendFile failed: %v", err)
	}

	content, err := sd.ReadFile(FileDecisions)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}
	if !strings.Contains(content, "## New Decision") {
		t.Error("appended content should be present in decisions.md")
	}
	if !strings.Contains(content, "# Decisions: test-task") {
		t.Error("original content should still be present")
	}
}

func TestAllSections(t *testing.T) {
	tmp := t.TempDir()
	sd, err := Init(tmp, "my-feature", "A cool feature")
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	sections, err := sd.AllSections()
	if err != nil {
		t.Fatalf("AllSections failed: %v", err)
	}

	if len(sections) != len(AllFiles) {
		t.Errorf("expected %d sections, got %d", len(AllFiles), len(sections))
	}

	projectBase := filepath.Base(tmp)
	for _, sec := range sections {
		expectedPrefix := "spec://" + projectBase + "/my-feature/"
		if !strings.HasPrefix(sec.URL, expectedPrefix) {
			t.Errorf("URL %q should have prefix %q", sec.URL, expectedPrefix)
		}
		if sec.Content == "" {
			t.Errorf("section %s should have non-empty content", sec.File)
		}
	}
}

func TestReadActiveNoFile(t *testing.T) {
	tmp := t.TempDir()
	_, err := ReadActive(tmp)
	if err == nil {
		t.Error("expected error when _active.md does not exist")
	}
}

func TestTemplatesParse(t *testing.T) {
	t.Parallel()
	data := TemplateData{
		TaskSlug:    "test-parse",
		Description: "Verify all templates parse",
		Date:        "2026-03-16",
	}
	rendered, err := RenderAll(data)
	if err != nil {
		t.Fatalf("RenderAll() = error %v", err)
	}
	if len(rendered) != len(AllFiles) {
		t.Errorf("RenderAll() returned %d files, want %d", len(rendered), len(AllFiles))
	}
	for _, f := range AllFiles {
		content, ok := rendered[f]
		if !ok {
			t.Errorf("RenderAll() missing file %s", f)
			continue
		}
		if content == "" {
			t.Errorf("RenderAll() file %s is empty", f)
		}
	}
}

func TestTemplatesSubstitution(t *testing.T) {
	t.Parallel()
	data := TemplateData{
		TaskSlug:    "my-feature",
		Description: "Build a search engine",
		Date:        "2026-03-16",
	}
	for _, tc := range []struct {
		file     SpecFile
		contains string
	}{
		{FileRequirements, "# Requirements: my-feature"},
		{FileRequirements, "Build a search engine"},
		{FileDesign, "# Design: my-feature"},
		{FileTasks, "# Tasks: my-feature"},
		{FileTestSpecs, "# Test Specifications: my-feature"},
		{FileDecisions, "# Decisions: my-feature"},
		{FileResearch, "# Research: my-feature"},
		{FileSession, "# Session: my-feature"},
	} {
		t.Run(string(tc.file), func(t *testing.T) {
			t.Parallel()
			content, err := RenderTemplate(tc.file, data)
			if err != nil {
				t.Fatalf("RenderTemplate(%s) = error %v", tc.file, err)
			}
			if !strings.Contains(content, tc.contains) {
				t.Errorf("RenderTemplate(%s) missing %q", tc.file, tc.contains)
			}
		})
	}
}

func TestInit7Files(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	sd, err := Init(tmp, "seven-files", "Test all 7 files")
	if err != nil {
		t.Fatalf("Init() = error %v", err)
	}
	for _, f := range AllFiles {
		if _, err := os.Stat(sd.FilePath(f)); err != nil {
			t.Errorf("Init() missing file %s: %v", f, err)
		}
	}
}

func TestAllSectionsBackwardCompat(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()

	// Create a legacy 4-file spec manually.
	sd := &SpecDir{ProjectPath: tmp, TaskSlug: "legacy-task"}
	if err := os.MkdirAll(sd.Dir(), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for _, f := range CoreFiles {
		if err := os.WriteFile(sd.FilePath(f), []byte("# "+string(f)), 0o644); err != nil {
			t.Fatalf("write %s: %v", f, err)
		}
	}

	// AllSections should succeed with only 4 files (skip missing 3).
	sections, err := sd.AllSections()
	if err != nil {
		t.Fatalf("AllSections() on 4-file spec = error %v", err)
	}
	if len(sections) != len(CoreFiles) {
		t.Errorf("AllSections() = %d sections, want %d (CoreFiles)", len(sections), len(CoreFiles))
	}
}

func TestInitRejectsInvalidSlug(t *testing.T) {
	tmp := t.TempDir()
	for _, slug := range []string{"../../evil", "has spaces", "UPPERCASE", "a/b", ""} {
		_, err := Init(tmp, slug, "test")
		if err == nil {
			t.Errorf("Init(%q) should fail with invalid slug", slug)
		}
	}
}

func TestInitRejectsOverwrite(t *testing.T) {
	tmp := t.TempDir()
	_, err := Init(tmp, "my-task", "first")
	if err != nil {
		t.Fatalf("first Init failed: %v", err)
	}
	_, err = Init(tmp, "my-task", "second")
	if err == nil {
		t.Error("second Init should fail — spec already exists")
	}
}

func TestActiveStateYAML(t *testing.T) {
	tmp := t.TempDir()

	// Init first task
	_, err := Init(tmp, "task-one", "First task")
	if err != nil {
		t.Fatalf("Init(task-one): %v", err)
	}

	// Verify YAML format
	state, err := ReadActiveState(tmp)
	if err != nil {
		t.Fatalf("ReadActiveState: %v", err)
	}
	if state.Primary != "task-one" {
		t.Errorf("Primary = %q, want %q", state.Primary, "task-one")
	}
	if len(state.Tasks) != 1 {
		t.Fatalf("len(Tasks) = %d, want 1", len(state.Tasks))
	}

	// Init second task — should add to list and become primary
	_, err = Init(tmp, "task-two", "Second task")
	if err != nil {
		t.Fatalf("Init(task-two): %v", err)
	}
	state, err = ReadActiveState(tmp)
	if err != nil {
		t.Fatalf("ReadActiveState after second init: %v", err)
	}
	if state.Primary != "task-two" {
		t.Errorf("Primary = %q, want %q", state.Primary, "task-two")
	}
	if len(state.Tasks) != 2 {
		t.Fatalf("len(Tasks) = %d, want 2", len(state.Tasks))
	}

	// ReadActive should return primary
	slug, err := ReadActive(tmp)
	if err != nil {
		t.Fatalf("ReadActive: %v", err)
	}
	if slug != "task-two" {
		t.Errorf("ReadActive() = %q, want %q", slug, "task-two")
	}
}

func TestSwitchActive(t *testing.T) {
	tmp := t.TempDir()
	Init(tmp, "alpha", "")
	Init(tmp, "beta", "")

	if err := SwitchActive(tmp, "alpha"); err != nil {
		t.Fatalf("SwitchActive(alpha): %v", err)
	}
	slug, _ := ReadActive(tmp)
	if slug != "alpha" {
		t.Errorf("ReadActive() = %q, want %q", slug, "alpha")
	}

	// Switch to nonexistent should fail
	if err := SwitchActive(tmp, "nope"); err == nil {
		t.Error("SwitchActive(nope) should fail")
	}
}

func TestRemoveTask(t *testing.T) {
	tmp := t.TempDir()
	Init(tmp, "keep", "")
	Init(tmp, "remove-me", "")

	// Remove non-primary
	allGone, err := RemoveTask(tmp, "remove-me")
	if err != nil {
		t.Fatalf("RemoveTask(remove-me): %v", err)
	}
	if allGone {
		t.Error("allGone should be false — 'keep' still exists")
	}
	state, _ := ReadActiveState(tmp)
	if len(state.Tasks) != 1 {
		t.Errorf("len(Tasks) = %d, want 1", len(state.Tasks))
	}

	// Spec dir should be removed
	sd := &SpecDir{ProjectPath: tmp, TaskSlug: "remove-me"}
	if sd.Exists() {
		t.Error("spec dir for 'remove-me' should be removed")
	}

	// Remove last task
	allGone, err = RemoveTask(tmp, "keep")
	if err != nil {
		t.Fatalf("RemoveTask(keep): %v", err)
	}
	if !allGone {
		t.Error("allGone should be true — no tasks left")
	}
}

func TestRemovePrimaryPromotes(t *testing.T) {
	tmp := t.TempDir()
	Init(tmp, "first", "")
	Init(tmp, "second", "")

	// primary is "second" (most recently init'd). Switch to "first".
	SwitchActive(tmp, "first")

	// Remove primary "first" — "second" should be promoted
	_, err := RemoveTask(tmp, "first")
	if err != nil {
		t.Fatalf("RemoveTask(first): %v", err)
	}
	slug, _ := ReadActive(tmp)
	if slug != "second" {
		t.Errorf("ReadActive() = %q, want %q after primary removal", slug, "second")
	}
}

func TestLegacyActiveFormat(t *testing.T) {
	tmp := t.TempDir()

	// Write legacy format manually
	os.MkdirAll(SpecsDir(tmp), 0o755)
	legacy := "task: old-task\nstarted_at: 2026-01-01T00:00:00Z\n"
	os.WriteFile(ActivePath(tmp), []byte(legacy), 0o644)

	slug, err := ReadActive(tmp)
	if err != nil {
		t.Fatalf("ReadActive(legacy): %v", err)
	}
	if slug != "old-task" {
		t.Errorf("ReadActive() = %q, want %q", slug, "old-task")
	}

	state, err := ReadActiveState(tmp)
	if err != nil {
		t.Fatalf("ReadActiveState(legacy): %v", err)
	}
	if len(state.Tasks) != 1 || state.Tasks[0].StartedAt != "2026-01-01T00:00:00Z" {
		t.Errorf("legacy state not parsed correctly: %+v", state)
	}
}

func TestSpecDirExists(t *testing.T) {
	tmp := t.TempDir()
	sd := &SpecDir{ProjectPath: tmp, TaskSlug: "nonexistent"}

	if sd.Exists() {
		t.Error("Exists() should return false before Init")
	}

	sd2, err := Init(tmp, "nonexistent", "test")
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	if !sd2.Exists() {
		t.Error("Exists() should return true after Init")
	}
}

func TestWriteFileAtomic(t *testing.T) {
	tmp := t.TempDir()
	sd, err := Init(tmp, "atomic-test", "test")
	if err != nil {
		t.Fatalf("Init: %v", err)
	}

	content := "# Updated Session\n\n## Status\nactive\n"
	if err := sd.WriteFile(context.Background(), FileSession, content); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	got, err := sd.ReadFile(FileSession)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if got != content {
		t.Errorf("WriteFile content mismatch: got %q, want %q", got, content)
	}

	// Verify no .tmp file remains.
	tmpFile := sd.FilePath(FileSession) + ".tmp"
	if _, err := os.Stat(tmpFile); err == nil {
		t.Error("tmp file should be cleaned up after atomic rename")
	}
}

func TestRootDir(t *testing.T) {
	got := RootDir("/home/user/project")
	want := filepath.Join("/home/user/project", ".alfred")
	if got != want {
		t.Errorf("RootDir() = %q, want %q", got, want)
	}
}

func TestCompleteTask(t *testing.T) {
	tmp := t.TempDir()
	Init(tmp, "task-a", "")
	Init(tmp, "task-b", "")

	// task-b is primary (most recently init'd). Complete it.
	newPrimary, err := CompleteTask(tmp, "task-b")
	if err != nil {
		t.Fatalf("CompleteTask(task-b): %v", err)
	}
	if newPrimary != "task-a" {
		t.Errorf("new primary = %q, want %q", newPrimary, "task-a")
	}

	// Verify state.
	state, _ := ReadActiveState(tmp)
	if len(state.Tasks) != 2 {
		t.Errorf("len(Tasks) = %d, want 2 (completed tasks remain)", len(state.Tasks))
	}
	for _, task := range state.Tasks {
		if task.Slug == "task-b" {
			if task.Status != TaskCompleted {
				t.Errorf("task-b status = %q, want %q", task.Status, TaskCompleted)
			}
			if task.CompletedAt == "" {
				t.Error("task-b completed_at should be set")
			}
		}
	}

	// Completing again should error.
	_, err = CompleteTask(tmp, "task-b")
	if err == nil {
		t.Error("completing already-completed task should fail")
	}

	// IsActive should return false for completed task.
	for _, task := range state.Tasks {
		if task.Slug == "task-b" && task.IsActive() {
			t.Error("completed task should not be active")
		}
		if task.Slug == "task-a" && !task.IsActive() {
			t.Error("active task should be active")
		}
	}
}

func TestRemoveTaskNotFound(t *testing.T) {
	tmp := t.TempDir()
	Init(tmp, "exists", "test")

	_, err := RemoveTask(tmp, "not-found")
	if err == nil {
		t.Error("RemoveTask should fail for non-existent task")
	}
}

func TestInitSessionTemplate(t *testing.T) {
	tmp := t.TempDir()
	sd, err := Init(tmp, "template-test", "check template")
	if err != nil {
		t.Fatalf("Init: %v", err)
	}

	session, err := sd.ReadFile(FileSession)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}

	// Verify activeContext format.
	for _, section := range []string{
		"## Status",
		"## Currently Working On",
		"## Recent Decisions",
		"## Next Steps",
		"## Blockers",
		"## Modified Files",
	} {
		if !strings.Contains(session, section) {
			t.Errorf("session template missing section %q", section)
		}
	}
}
