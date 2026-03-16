package spec

import (
	"context"
	"os"
	"testing"
)

func setupValidateSpec(t *testing.T, size SpecSize, specType SpecType) *SpecDir {
	t.Helper()
	tmp := t.TempDir()
	sd, err := Init(tmp, "validate-test", "Test validation", WithSize(size), WithSpecType(specType))
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	return sd
}

func TestValidateWellFormedSpec(t *testing.T) {
	t.Parallel()
	sd := setupValidateSpec(t, SizeL, TypeFeature)

	// Write well-formed requirements.md with FRs and confidence.
	reqs := `# Requirements: validate-test

## Goal
<!-- confidence: 8 | source: user -->
Test validation

## Functional Requirements

### FR-1: First requirement
<!-- confidence: 7 | source: code -->
WHEN something, the system SHALL do something.

### FR-2: Second
### FR-3: Third
### FR-4: Fourth
### FR-5: Fifth
`
	sd.WriteFile(context.Background(), FileRequirements, reqs)

	// Write design.md with traceability.
	design := `# Design: validate-test

## Requirements Traceability

| Req ID | Component |
|--------|-----------|
| FR-1 | ComponentA |
| FR-2 | ComponentB |
| FR-3 | ComponentC |
| FR-4 | ComponentD |
| FR-5 | ComponentE |
`
	sd.WriteFile(context.Background(), FileDesign, design)

	// Write tasks.md with closing wave and FR references.
	tasks := `# Tasks: validate-test

## Wave 1
- [ ] T-1.1 [S] First task
  _Requirements: FR-1_

## Wave: Closing
- [ ] T-C.1 Self-review
`
	sd.WriteFile(context.Background(), FileTasks, tasks)

	report, err := Validate(sd, SizeL, TypeFeature)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}

	for _, c := range report.Checks {
		if c.Status != "pass" {
			t.Errorf("check %s: %s (%s)", c.Name, c.Status, c.Message)
		}
	}
	if report.Summary != "6/6 checks passed" {
		t.Errorf("Summary = %q, want '6/6 checks passed'", report.Summary)
	}
}

func TestValidateEmptySpec(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	sd := &SpecDir{ProjectPath: tmp, TaskSlug: "empty-spec"}
	os.MkdirAll(sd.Dir(), 0o755)

	report, err := Validate(sd, SizeS, TypeFeature)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}

	// required_sections should fail (no requirements.md).
	for _, c := range report.Checks {
		if c.Name == "required_sections" && c.Status != "fail" {
			t.Errorf("required_sections should fail on empty spec")
		}
	}
}

func TestValidateFRCountBySize(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		size     SpecSize
		frCount  int
		wantPass bool
	}{
		{"S_0_FRs", SizeS, 0, false},
		{"S_1_FR", SizeS, 1, true},
		{"M_2_FRs", SizeM, 2, false},
		{"M_3_FRs", SizeM, 3, true},
		{"L_4_FRs", SizeL, 4, false},
		{"L_5_FRs", SizeL, 5, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tmp := t.TempDir()
			sd := &SpecDir{ProjectPath: tmp, TaskSlug: "fr-count"}
			os.MkdirAll(sd.Dir(), 0o755)

			// Build requirements.md with N FRs.
			content := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n"
			for i := 1; i <= tc.frCount; i++ {
				content += "### FR-" + string(rune('0'+i)) + ": Requirement\n"
			}
			os.WriteFile(sd.FilePath(FileRequirements), []byte(content), 0o644)

			report, _ := Validate(sd, tc.size, TypeFeature)
			for _, c := range report.Checks {
				if c.Name == "min_fr_count" {
					if tc.wantPass && c.Status != "pass" {
						t.Errorf("min_fr_count = %s, want pass (%s)", c.Status, c.Message)
					}
					if !tc.wantPass && c.Status != "fail" {
						t.Errorf("min_fr_count = %s, want fail (%s)", c.Status, c.Message)
					}
				}
			}
		})
	}
}

func TestValidateTraceabilityFail(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	sd := &SpecDir{ProjectPath: tmp, TaskSlug: "trace-test"}
	os.MkdirAll(sd.Dir(), 0o755)

	reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n### FR-2: Req2\n"
	os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)

	// design.md only mentions FR-1, not FR-2.
	design := "# Design\n\n## Traceability\n| FR-1 | ComponentA |\n"
	os.WriteFile(sd.FilePath(FileDesign), []byte(design), 0o644)

	report, _ := Validate(sd, SizeL, TypeFeature)
	for _, c := range report.Checks {
		if c.Name == "traceability_fr_to_task" && c.Status != "fail" {
			t.Errorf("traceability should fail for unmapped FR-2, got %s: %s", c.Status, c.Message)
		}
	}
}

func TestValidateMissingFiles(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	sd := &SpecDir{ProjectPath: tmp, TaskSlug: "partial"}
	os.MkdirAll(sd.Dir(), 0o755)

	// Only create requirements.md.
	reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n"
	os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)

	report, err := Validate(sd, SizeS, TypeFeature)
	if err != nil {
		t.Fatalf("Validate should not error on missing files: %v", err)
	}
	// Should still have checks — some pass, some fail gracefully.
	if len(report.Checks) == 0 {
		t.Error("Validate should return checks even with missing files")
	}
}

func TestValidateBugfix(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	sd, err := Init(tmp, "bugfix-validate", "fix bug", WithSize(SizeS), WithSpecType(TypeBugfix))
	if err != nil {
		t.Fatalf("Init: %v", err)
	}

	report, err := Validate(sd, SizeS, TypeBugfix)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}

	// required_sections should check bugfix.md for "## Bug Summary".
	for _, c := range report.Checks {
		if c.Name == "required_sections" && c.Status != "pass" {
			t.Errorf("required_sections should pass for bugfix template: %s", c.Message)
		}
	}
}
