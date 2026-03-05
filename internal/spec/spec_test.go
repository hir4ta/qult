package spec

import (
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

	// Check all 6 spec files exist
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
	if err := sd.AppendFile(FileDecisions, appendContent); err != nil {
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
