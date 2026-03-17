package spec

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenderSteering(t *testing.T) {
	t.Parallel()

	data := SteeringData{
		ProjectName:  "test-project",
		Description:  "A test project for unit tests",
		TechStack:    "Go 1.25",
		Dependencies: []string{"github.com/foo/bar", "github.com/baz/qux"},
		Packages:     []string{"cmd/", "internal/", "pkg/"},
		Conventions:  []string{"Use gofmt", "Error strings lowercase"},
		Date:         "2026-03-16",
	}

	rendered, err := RenderSteering(data, "")
	if err != nil {
		t.Fatalf("RenderSteering() error: %v", err)
	}

	if len(rendered) != len(AllSteeringFiles) {
		t.Errorf("RenderSteering() returned %d files, want %d", len(rendered), len(AllSteeringFiles))
	}

	for _, f := range AllSteeringFiles {
		content, ok := rendered[f]
		if !ok {
			t.Errorf("RenderSteering() missing file %s", f)
			continue
		}
		if !strings.Contains(content, "test-project") {
			t.Errorf("RenderSteering() %s does not contain project name", f)
		}
		lines := strings.Split(content, "\n")
		if len(lines) < 10 {
			t.Errorf("RenderSteering() %s has only %d lines, want >= 10", f, len(lines))
		}
	}

	// Check specific content in each file.
	if !strings.Contains(rendered[SteeringProduct], "A test project for unit tests") {
		t.Error("product.md should contain description")
	}
	if !strings.Contains(rendered[SteeringTech], "Go 1.25") {
		t.Error("tech.md should contain tech stack")
	}
	if !strings.Contains(rendered[SteeringTech], "github.com/foo/bar") {
		t.Error("tech.md should contain dependencies")
	}
	if !strings.Contains(rendered[SteeringStructure], "cmd/") {
		t.Error("structure.md should contain packages")
	}
	if !strings.Contains(rendered[SteeringStructure], "Use gofmt") {
		t.Error("structure.md should contain conventions")
	}
}

func TestSteeringExistsAndDir(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()

	// No steering dir yet.
	if SteeringExists(tmp) {
		t.Error("SteeringExists() = true for empty project, want false")
	}

	// Create steering dir with a file.
	dir := SteeringDir(tmp)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "product.md"), []byte("# Product"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if !SteeringExists(tmp) {
		t.Error("SteeringExists() = false after creating steering file, want true")
	}

	// Verify dir path.
	expected := filepath.Join(tmp, ".alfred", "steering")
	if dir != expected {
		t.Errorf("SteeringDir() = %s, want %s", dir, expected)
	}
}

func TestWriteAndReadSteering(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()

	data := SteeringData{
		ProjectName:  "my-app",
		Description:  "My application",
		TechStack:    "Go 1.25",
		Dependencies: []string{"dep-a"},
		Packages:     []string{"cmd/"},
		Conventions:  []string{"lowercase errors"},
		Date:         "2026-03-16",
	}

	rendered, err := RenderSteering(data, "")
	if err != nil {
		t.Fatalf("RenderSteering: %v", err)
	}

	// Write.
	if err := WriteSteering(tmp, rendered, false); err != nil {
		t.Fatalf("WriteSteering: %v", err)
	}

	// Write again without force should fail.
	if err := WriteSteering(tmp, rendered, false); err == nil {
		t.Error("WriteSteering() should fail when docs exist and force=false")
	}

	// Write with force should succeed.
	if err := WriteSteering(tmp, rendered, true); err != nil {
		t.Errorf("WriteSteering(force=true) error: %v", err)
	}

	// Read back.
	docs, err := ReadSteering(tmp)
	if err != nil {
		t.Fatalf("ReadSteering: %v", err)
	}
	if len(docs) != 3 {
		t.Errorf("ReadSteering() returned %d files, want 3", len(docs))
	}
	for _, f := range AllSteeringFiles {
		if _, ok := docs[f]; !ok {
			t.Errorf("ReadSteering() missing file %s", f)
		}
	}
}

func TestReadSteeringPartial(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()

	// Create only product.md.
	dir := SteeringDir(tmp)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "product.md"), []byte("# Product\nTest"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	docs, err := ReadSteering(tmp)
	if err != nil {
		t.Fatalf("ReadSteering: %v", err)
	}
	if len(docs) != 1 {
		t.Errorf("ReadSteering() returned %d files, want 1 (partial)", len(docs))
	}
	if _, ok := docs[SteeringProduct]; !ok {
		t.Error("ReadSteering() should include product.md")
	}
}

func TestSteeringSummary(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()

	// No docs.
	summary, err := SteeringSummary(tmp)
	if err != nil {
		t.Fatalf("SteeringSummary: %v", err)
	}
	if summary != "" {
		t.Error("SteeringSummary() should return empty string when no docs exist")
	}

	// Create docs.
	data := SteeringData{
		ProjectName: "summary-test",
		Description: "Testing summary",
		TechStack:   "Go",
	}
	rendered, err := RenderSteering(data, "")
	if err != nil {
		t.Fatalf("RenderSteering: %v", err)
	}
	if err := WriteSteering(tmp, rendered, false); err != nil {
		t.Fatalf("WriteSteering: %v", err)
	}

	summary, err = SteeringSummary(tmp)
	if err != nil {
		t.Fatalf("SteeringSummary: %v", err)
	}
	if summary == "" {
		t.Error("SteeringSummary() should return non-empty summary when docs exist")
	}
	if !strings.Contains(summary, "product.md") {
		t.Error("SteeringSummary() should reference product.md")
	}
}

func TestReadSteeringEmpty(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()

	docs, err := ReadSteering(tmp)
	if err != nil {
		t.Fatalf("ReadSteering: %v", err)
	}
	if len(docs) != 0 {
		t.Errorf("ReadSteering() returned %d files for nonexistent dir, want 0", len(docs))
	}
}

func TestValidateSteeringDrift(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()

	// Create go.mod with specific deps.
	goMod := `module github.com/test/proj

go 1.25.0

require (
	github.com/gin-gonic/gin v1.9.0
	github.com/lib/pq v1.10.0
)
`
	if err := os.WriteFile(filepath.Join(tmp, "go.mod"), []byte(goMod), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// Create tech.md that references a dep NOT in go.mod.
	dir := SteeringDir(tmp)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	techContent := `# Tech: proj

## Stack
- **Language**: Go 1.25

## Dependencies
- gin
- nonexistent-package
`
	if err := os.WriteFile(filepath.Join(dir, "tech.md"), []byte(techContent), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	warnings, err := ValidateSteering(tmp)
	if err != nil {
		t.Fatalf("ValidateSteering: %v", err)
	}

	// Should detect drift for nonexistent-package.
	found := false
	for _, w := range warnings {
		if w.Kind == "drift" && strings.Contains(w.Message, "nonexistent-package") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("ValidateSteering() should detect drift for nonexistent-package, got: %v", warnings)
	}
}

func TestValidateSteeringMissingDir(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()

	// Create structure.md referencing a nonexistent directory.
	dir := SteeringDir(tmp)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	// Create a real directory to verify it's not warned about.
	os.MkdirAll(filepath.Join(tmp, "cmd"), 0o755)

	structContent := `# Structure: proj

## Directory Layout
` + "```\n- cmd/\n- nonexistent-dir/\n```\n"
	if err := os.WriteFile(filepath.Join(dir, "structure.md"), []byte(structContent), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	warnings, err := ValidateSteering(tmp)
	if err != nil {
		t.Fatalf("ValidateSteering: %v", err)
	}

	// Should warn about nonexistent-dir but not cmd.
	foundMissing := false
	for _, w := range warnings {
		if w.Kind == "missing_dir" && strings.Contains(w.Message, "nonexistent-dir") {
			foundMissing = true
		}
		if w.Kind == "missing_dir" && strings.Contains(w.Message, "cmd") {
			t.Error("ValidateSteering() should NOT warn about existing directory cmd/")
		}
	}
	if !foundMissing {
		t.Errorf("ValidateSteering() should detect missing directory, got: %v", warnings)
	}
}

func TestValidateSteeringClean(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()

	// Create a clean project with consistent steering docs.
	os.MkdirAll(filepath.Join(tmp, "cmd"), 0o755)
	os.MkdirAll(filepath.Join(tmp, "internal"), 0o755)

	goMod := `module github.com/test/proj

go 1.25.0

require (
	github.com/gin-gonic/gin v1.9.0
)
`
	if err := os.WriteFile(filepath.Join(tmp, "go.mod"), []byte(goMod), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	dir := SteeringDir(tmp)
	os.MkdirAll(dir, 0o755)

	techContent := `# Tech: proj

## Stack
- **Language**: Go 1.25

## Dependencies
- gin
`
	structContent := `# Structure: proj

## Directory Layout
` + "```\n- cmd/\n- internal/\n```\n"

	os.WriteFile(filepath.Join(dir, "tech.md"), []byte(techContent), 0o644)
	os.WriteFile(filepath.Join(dir, "structure.md"), []byte(structContent), 0o644)
	os.WriteFile(filepath.Join(dir, "product.md"), []byte("# Product: proj\n"), 0o644)

	warnings, err := ValidateSteering(tmp)
	if err != nil {
		t.Fatalf("ValidateSteering: %v", err)
	}
	if len(warnings) != 0 {
		t.Errorf("ValidateSteering() should return no warnings for clean project, got: %v", warnings)
	}
}

func TestValidateSteeringNoDocs(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()

	warnings, err := ValidateSteering(tmp)
	if err != nil {
		t.Fatalf("ValidateSteering: %v", err)
	}
	if warnings != nil {
		t.Errorf("ValidateSteering() should return nil for project without steering docs, got: %v", warnings)
	}
}
