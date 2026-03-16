package spec

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
)

// assertCheckStatus verifies a named check exists in the report and has the expected status.
func assertCheckStatus(t *testing.T, report *ValidationReport, name, wantStatus string) {
	t.Helper()
	for _, c := range report.Checks {
		if c.Name == name {
			if c.Status != wantStatus {
				t.Errorf("%s = %s, want %s (%s)", name, c.Status, wantStatus, c.Message)
			}
			return
		}
	}
	t.Errorf("%s check not found in report (expected %s)", name, wantStatus)
}

// assertCheckAbsent verifies a named check is NOT in the report (was skipped).
func assertCheckAbsent(t *testing.T, report *ValidationReport, name string) {
	t.Helper()
	for _, c := range report.Checks {
		if c.Name == name {
			t.Errorf("%s should be skipped, but found with status %s", name, c.Status)
			return
		}
	}
}

// assertCheckMessageContains verifies a named check exists, has the expected status,
// and its message contains the substring.
func assertCheckMessageContains(t *testing.T, report *ValidationReport, name, wantStatus, substr string) {
	t.Helper()
	for _, c := range report.Checks {
		if c.Name == name {
			if c.Status != wantStatus {
				t.Errorf("%s = %s, want %s (%s)", name, c.Status, wantStatus, c.Message)
			}
			if !strings.Contains(c.Message, substr) {
				t.Errorf("%s message should contain %q, got %q", name, substr, c.Message)
			}
			return
		}
	}
	t.Errorf("%s check not found in report", name)
}

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

	// Write well-formed requirements.md with FRs, NFRs, and confidence.
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

## Non-Functional Requirements

### NFR-1: Performance
The system SHALL respond within 200ms.
`
	sd.WriteFile(context.Background(), FileRequirements, reqs)

	// Write design.md with traceability including NFR.
	design := `# Design: validate-test

## Requirements Traceability

| Req ID | Component |
|--------|-----------|
| FR-1 | ComponentA |
| FR-2 | ComponentB |
| FR-3 | ComponentC |
| FR-4 | ComponentD |
| FR-5 | ComponentE |
| NFR-1 | ComponentA |
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

	// Write test-specs.md with gherkin blocks and source annotations.
	testSpecs := `# Test Specifications: validate-test

## Coverage Matrix
| Req ID | Test IDs | Type | Priority | Status |
|--------|----------|------|----------|--------|
| FR-1   | TS-1.1   | Unit | P0       | Pending |

## Test Cases

### TS-1.1: First test (FR-1, Happy Path)
<!-- source: FR-1 -->
` + "```gherkin\nGiven a precondition\nWhen an action occurs\nThen the expected result happens\n```\n"
	sd.WriteFile(context.Background(), FileTestSpecs, testSpecs)

	// Write decisions.md with complete DEC entry.
	decisions := `# Decisions: validate-test

## DEC-1: [2026-03-16] Test Decision
<!-- confidence: 8 | source: user -->
- **Status**: Accepted
- **Context**: Test context for validation
- **Chosen**: Option A
- **Rationale**: Simplicity over complexity
`
	sd.WriteFile(context.Background(), FileDecisions, decisions)

	// Write research.md with required sections.
	research := `# Research: validate-test

## Discovery Summary
Key findings from research phase.

## Gap Analysis
Current state and required changes identified.

## Implementation Options
### Option A: Direct approach
Straightforward implementation.

## Done Criteria
- [x] All gaps identified
`
	sd.WriteFile(context.Background(), FileResearch, research)

	report, err := Validate(sd, SizeL, TypeFeature)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}

	for _, c := range report.Checks {
		if c.Status != "pass" {
			t.Errorf("check %s: %s (%s)", c.Name, c.Status, c.Message)
		}
	}
	// 12 original + 3 v6 checks + 1 grounding_coverage (opt-in auto-pass) = 16 total.
	if report.Summary != "16/16 checks passed" {
		t.Errorf("Summary = %q, want '16/16 checks passed'", report.Summary)
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

func TestValidateDesignFRReferences(t *testing.T) {
	t.Parallel()

	t.Run("valid_references_pass", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "design-fr"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n### FR-2: Req2\n### FR-3: Req3\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		design := "# Design\n\n## Traceability\n| FR-1 | A |\n| FR-2 | B |\n| FR-3 | C |\n"
		os.WriteFile(sd.FilePath(FileDesign), []byte(design), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckStatus(t, report, "design_fr_references", "pass")
	})

	t.Run("invalid_references_fail", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "design-fr-fail"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n### FR-2: Req2\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		design := "# Design\n\n## Traceability\n| FR-1 | A |\n| FR-5 | B |\n"
		os.WriteFile(sd.FilePath(FileDesign), []byte(design), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckMessageContains(t, report, "design_fr_references", "fail", "FR-5")
	})

	t.Run("s_size_skips", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "design-fr-skip"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)

		report, _ := Validate(sd, SizeS, TypeFeature)
		assertCheckAbsent(t, report, "design_fr_references")
	})
}

func TestValidateTestSpecFRReferences(t *testing.T) {
	t.Parallel()

	t.Run("valid_pass", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "ts-fr"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n### FR-2: Req2\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		testSpecs := "# Test Specs\n\n| FR-1 | TS-1.1 |\n| FR-2 | TS-2.1 |\n"
		os.WriteFile(sd.FilePath(FileTestSpecs), []byte(testSpecs), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckStatus(t, report, "testspec_fr_references", "pass")
	})

	t.Run("invalid_fail", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "ts-fr-fail"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		testSpecs := "# Test Specs\n\n| FR-1 | TS-1.1 |\n| FR-99 | TS-99.1 |\n"
		os.WriteFile(sd.FilePath(FileTestSpecs), []byte(testSpecs), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckMessageContains(t, report, "testspec_fr_references", "fail", "FR-99")
	})
}

func TestValidateNFRTraceability(t *testing.T) {
	t.Parallel()

	t.Run("mapped_pass", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "nfr-pass"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n\n### NFR-1: Performance\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		design := "# Design\n\n## Traceability\n| FR-1 | A |\n| NFR-1 | A |\n"
		os.WriteFile(sd.FilePath(FileDesign), []byte(design), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckStatus(t, report, "nfr_traceability", "pass")
	})

	t.Run("unmapped_fail", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "nfr-fail"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n\n### NFR-1: Performance\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		design := "# Design\n\n## Traceability\n| FR-1 | A |\n"
		os.WriteFile(sd.FilePath(FileDesign), []byte(design), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckStatus(t, report, "nfr_traceability", "fail")
	})

	t.Run("no_nfr_skips", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "nfr-skip"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckAbsent(t, report, "nfr_traceability")
	})

	t.Run("m_size_skips", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "nfr-m"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n\n### NFR-1: Perf\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)

		report, _ := Validate(sd, SizeM, TypeFeature)
		assertCheckAbsent(t, report, "nfr_traceability")
	})
}

func TestValidateGherkinSyntax(t *testing.T) {
	t.Parallel()

	t.Run("valid_pass", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "gherkin-pass"}
		os.MkdirAll(sd.Dir(), 0o755)

		content := "# Test Specs\n\n" +
			"```gherkin\nGiven a precondition\nWhen an action\nThen a result\n```\n"
		os.WriteFile(sd.FilePath(FileTestSpecs), []byte(content), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckStatus(t, report, "gherkin_syntax", "pass")
	})

	t.Run("missing_then_fail", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "gherkin-fail"}
		os.MkdirAll(sd.Dir(), 0o755)

		content := "# Test Specs\n\n" +
			"```gherkin\nGiven a precondition\nWhen an action\n```\n"
		os.WriteFile(sd.FilePath(FileTestSpecs), []byte(content), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckStatus(t, report, "gherkin_syntax", "fail")
	})

	t.Run("no_blocks_skips", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "gherkin-skip"}
		os.MkdirAll(sd.Dir(), 0o755)

		content := "# Test Specs\n\nNo gherkin blocks here.\n"
		os.WriteFile(sd.FilePath(FileTestSpecs), []byte(content), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckAbsent(t, report, "gherkin_syntax")
	})
}

func TestValidateOrphanTests(t *testing.T) {
	t.Parallel()

	t.Run("linked_pass", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "orphan-test-pass"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		testSpecs := "# Test Specs\n\n### TS-1.1: Test\n<!-- source: FR-1 -->\n"
		os.WriteFile(sd.FilePath(FileTestSpecs), []byte(testSpecs), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckStatus(t, report, "orphan_tests", "pass")
	})

	t.Run("orphan_fail", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "orphan-test-fail"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		testSpecs := "# Test Specs\n\n### TS-1.1: Test\n<!-- source: FR-99 -->\n"
		os.WriteFile(sd.FilePath(FileTestSpecs), []byte(testSpecs), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckMessageContains(t, report, "orphan_tests", "fail", "FR-99")
	})
}

func TestValidateOrphanTasks(t *testing.T) {
	t.Parallel()

	t.Run("linked_pass", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "orphan-task-pass"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		tasks := "# Tasks\n\n## Wave 1\n- [ ] T-1.1 [S] Task\n  _Requirements: FR-1_\n\n## Wave: Closing\n- [ ] T-C.1 Review\n"
		os.WriteFile(sd.FilePath(FileTasks), []byte(tasks), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckStatus(t, report, "orphan_tasks", "pass")
	})

	t.Run("orphan_fail", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "orphan-task-fail"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		tasks := "# Tasks\n\n## Wave 1\n- [ ] T-2.1 [S] Task\n  _Requirements: FR-99_\n\n## Wave: Closing\n- [ ] T-C.1 Review\n"
		os.WriteFile(sd.FilePath(FileTasks), []byte(tasks), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckMessageContains(t, report, "orphan_tasks", "fail", "FR-99")
	})
}

func TestValidateBugfix(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	sd, err := Init(tmp, "bugfix-validate", "fix bug with real content describing the issue in detail", WithSize(SizeS), WithSpecType(TypeBugfix))
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

// --- v6 Tests ---

func TestValidateContentPlaceholders(t *testing.T) {
	t.Parallel()

	t.Run("placeholder_TBD_fails", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "placeholder-tbd"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: TBD\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckMessageContains(t, report, "content_placeholder", "fail", "FR-1")
	})

	t.Run("placeholder_template_var_fails", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "placeholder-var"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: {Requirement Name}\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckMessageContains(t, report, "content_placeholder", "fail", "FR-1")
	})

	t.Run("real_title_passes", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "placeholder-ok"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: User Authentication\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckStatus(t, report, "content_placeholder", "pass")
	})

	t.Run("placeholder_in_comment_not_flagged", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "placeholder-comment"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n<!-- example:\n### FR-1: TBD\n-->\n### FR-1: Real Requirement\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckStatus(t, report, "content_placeholder", "pass")
	})
}

func TestValidateDecisionsCompleteness(t *testing.T) {
	t.Parallel()

	t.Run("complete_DEC_passes", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "dec-pass"}
		os.MkdirAll(sd.Dir(), 0o755)

		os.WriteFile(sd.FilePath(FileRequirements), []byte("## Goal\n"), 0o644)
		dec := "# Decisions\n\n## DEC-1: Test\n- **Status**: Accepted\n- **Context**: Test context\n- **Chosen**: Option A\n- **Rationale**: Simplicity\n"
		os.WriteFile(sd.FilePath(FileDecisions), []byte(dec), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckStatus(t, report, "decisions_completeness", "pass")
	})

	t.Run("missing_Rationale_fails", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "dec-fail"}
		os.MkdirAll(sd.Dir(), 0o755)

		os.WriteFile(sd.FilePath(FileRequirements), []byte("## Goal\n"), 0o644)
		dec := "# Decisions\n\n## DEC-1: Test\n- **Status**: Accepted\n- **Context**: Test context\n- **Chosen**: Option A\n"
		os.WriteFile(sd.FilePath(FileDecisions), []byte(dec), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckMessageContains(t, report, "decisions_completeness", "fail", "Rationale")
	})

	t.Run("S_size_skips", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "dec-skip"}
		os.MkdirAll(sd.Dir(), 0o755)

		os.WriteFile(sd.FilePath(FileRequirements), []byte("## Goal\n"), 0o644)

		report, _ := Validate(sd, SizeS, TypeFeature)
		assertCheckAbsent(t, report, "decisions_completeness")
	})
}

func TestValidateConfidenceCoverage(t *testing.T) {
	t.Parallel()

	t.Run("XL_all_covered_passes", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "conf-cov-pass"}
		os.MkdirAll(sd.Dir(), 0o755)

		var b strings.Builder
		b.WriteString("# Requirements\n\n## Goal\n<!-- confidence: 9 | source: user -->\nTest\n\n")
		for i := 1; i <= 8; i++ {
			fmt.Fprintf(&b, "### FR-%d: Requirement %d\n<!-- confidence: 7 | source: code -->\n\n", i, i)
		}
		b.WriteString("### NFR-1: Performance\n")
		os.WriteFile(sd.FilePath(FileRequirements), []byte(b.String()), 0o644)

		report, _ := Validate(sd, SizeXL, TypeFeature)
		assertCheckStatus(t, report, "confidence_coverage", "pass")
	})

	t.Run("XL_missing_confidence_fails", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "conf-cov-fail"}
		os.MkdirAll(sd.Dir(), 0o755)

		var b strings.Builder
		b.WriteString("# Requirements\n\n## Goal\n<!-- confidence: 9 | source: user -->\nTest\n\n")
		for i := 1; i <= 8; i++ {
			if i == 3 {
				fmt.Fprintf(&b, "### FR-%d: Requirement %d\n\n", i, i) // no confidence
			} else {
				fmt.Fprintf(&b, "### FR-%d: Requirement %d\n<!-- confidence: 7 | source: code -->\n\n", i, i)
			}
		}
		b.WriteString("### NFR-1: Performance\n")
		os.WriteFile(sd.FilePath(FileRequirements), []byte(b.String()), 0o644)

		report, _ := Validate(sd, SizeXL, TypeFeature)
		assertCheckMessageContains(t, report, "confidence_coverage", "fail", "FR-3")
	})

	t.Run("L_size_skips", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "conf-cov-skip"}
		os.MkdirAll(sd.Dir(), 0o755)

		os.WriteFile(sd.FilePath(FileRequirements), []byte("## Goal\n<!-- confidence: 7 | source: user -->\n### FR-1: Req\n"), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckAbsent(t, report, "confidence_coverage")
	})
}

func TestValidateXLWaveCount(t *testing.T) {
	t.Parallel()

	t.Run("4_waves_passes", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "xl-wave-pass"}
		os.MkdirAll(sd.Dir(), 0o755)

		os.WriteFile(sd.FilePath(FileRequirements), []byte("## Goal\n"), 0o644)
		tasks := "# Tasks\n\n## Wave 1: Foundation\n## Wave 2: Core\n## Wave 3: Edge\n## Wave 4: Polish\n## Wave: Closing\n"
		os.WriteFile(sd.FilePath(FileTasks), []byte(tasks), 0o644)

		report, _ := Validate(sd, SizeXL, TypeFeature)
		assertCheckStatus(t, report, "xl_wave_count", "pass")
	})

	t.Run("2_waves_fails", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "xl-wave-fail"}
		os.MkdirAll(sd.Dir(), 0o755)

		os.WriteFile(sd.FilePath(FileRequirements), []byte("## Goal\n"), 0o644)
		tasks := "# Tasks\n\n## Wave 1: Foundation\n## Wave 2: Core\n## Wave: Closing\n"
		os.WriteFile(sd.FilePath(FileTasks), []byte(tasks), 0o644)

		report, _ := Validate(sd, SizeXL, TypeFeature)
		assertCheckMessageContains(t, report, "xl_wave_count", "fail", "2 waves")
	})

	t.Run("L_size_skips", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "xl-wave-skip"}
		os.MkdirAll(sd.Dir(), 0o755)

		os.WriteFile(sd.FilePath(FileRequirements), []byte("## Goal\n"), 0o644)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckAbsent(t, report, "xl_wave_count")
	})
}

func TestValidateXLNFRRequired(t *testing.T) {
	t.Parallel()

	t.Run("NFR_defined_passes", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "xl-nfr-pass"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n\n### NFR-1: Performance\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)

		report, _ := Validate(sd, SizeXL, TypeFeature)
		assertCheckStatus(t, report, "xl_nfr_required", "pass")
	})

	t.Run("no_NFR_fails", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "xl-nfr-fail"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := "# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n### FR-1: Req\n"
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)

		report, _ := Validate(sd, SizeXL, TypeFeature)
		assertCheckStatus(t, report, "xl_nfr_required", "fail")
	})
}

func TestValidateXLMinFRCount(t *testing.T) {
	t.Parallel()

	t.Run("XL_7_FRs_fails", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "xl-fr-fail"}
		os.MkdirAll(sd.Dir(), 0o755)

		var b strings.Builder
		b.WriteString("# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n")
		for i := 1; i <= 7; i++ {
			fmt.Fprintf(&b, "### FR-%d: Requirement %d\n", i, i)
		}
		os.WriteFile(sd.FilePath(FileRequirements), []byte(b.String()), 0o644)

		report, _ := Validate(sd, SizeXL, TypeFeature)
		assertCheckMessageContains(t, report, "min_fr_count", "fail", "minimum 8")
	})

	t.Run("XL_8_FRs_passes", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "xl-fr-pass"}
		os.MkdirAll(sd.Dir(), 0o755)

		var b strings.Builder
		b.WriteString("# Requirements\n\n## Goal\n<!-- confidence: 7 | source: user -->\nTest\n\n")
		for i := 1; i <= 8; i++ {
			fmt.Fprintf(&b, "### FR-%d: Requirement %d\n", i, i)
		}
		os.WriteFile(sd.FilePath(FileRequirements), []byte(b.String()), 0o644)

		report, _ := Validate(sd, SizeXL, TypeFeature)
		assertCheckStatus(t, report, "min_fr_count", "pass")
	})
}

func TestValidateDelta(t *testing.T) {
	t.Parallel()

	t.Run("init_creates_delta_files", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd, err := Init(tmp, "delta-test", "small fix", WithSize(SizeDelta))
		if err != nil {
			t.Fatalf("Init: %v", err)
		}
		// delta.md and session.md should exist.
		if _, err := sd.ReadFile(FileDelta); err != nil {
			t.Errorf("delta.md should exist: %v", err)
		}
		if _, err := sd.ReadFile(FileSession); err != nil {
			t.Errorf("session.md should exist: %v", err)
		}
		// requirements.md should NOT exist.
		if _, err := sd.ReadFile(FileRequirements); err == nil {
			t.Error("requirements.md should not exist for delta spec")
		}
	})

	t.Run("delta_validation_passes", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "delta-valid"}
		os.MkdirAll(sd.Dir(), 0o755)

		delta := "# Delta: delta-valid\n\n## Change Summary\nFix null pointer in validator.\n\n## Files Affected\n- `internal/spec/validate.go` — fix nil check\n\n## Rationale\nBug report from production.\n\n## Impact Scope\nLow risk change.\n\n## Test Plan\n- `go test ./internal/spec/...`\n\n## Rollback Strategy\n- `git revert`\n"
		os.WriteFile(sd.FilePath(FileDelta), []byte(delta), 0o644)

		report, err := Validate(sd, SizeDelta, TypeDelta)
		if err != nil {
			t.Fatalf("Validate: %v", err)
		}
		assertCheckStatus(t, report, "required_sections", "pass")
		assertCheckStatus(t, report, "delta_sections_present", "pass")
	})

	t.Run("delta_missing_sections_fails", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "delta-fail"}
		os.MkdirAll(sd.Dir(), 0o755)

		delta := "# Delta: delta-fail\n\n## Change Summary\nSome change.\n"
		os.WriteFile(sd.FilePath(FileDelta), []byte(delta), 0o644)

		report, err := Validate(sd, SizeDelta, TypeDelta)
		if err != nil {
			t.Fatalf("Validate: %v", err)
		}
		assertCheckStatus(t, report, "delta_sections_present", "fail")
	})
}

func TestParseSizeDelta(t *testing.T) {
	t.Parallel()
	size, err := ParseSize("D")
	if err != nil {
		t.Fatalf("ParseSize(D): %v", err)
	}
	if size != SizeDelta {
		t.Errorf("ParseSize(D) = %q, want %q", size, SizeDelta)
	}
}

func TestFilesForSizeDelta(t *testing.T) {
	t.Parallel()
	files := FilesForSize(SizeDelta, TypeFeature)
	if len(files) != 2 {
		t.Fatalf("FilesForSize(D) = %d files, want 2", len(files))
	}
	if files[0] != FileDelta {
		t.Errorf("files[0] = %q, want %q", files[0], FileDelta)
	}
	if files[1] != FileSession {
		t.Errorf("files[1] = %q, want %q", files[1], FileSession)
	}
}

func TestDetectSizeNeverReturnsDelta(t *testing.T) {
	t.Parallel()
	for _, desc := range []string{"x", strings.Repeat("a", 50), strings.Repeat("b", 200), strings.Repeat("c", 1000)} {
		size := DetectSize(desc)
		if size == SizeDelta || size == SizeXL {
			t.Errorf("DetectSize(%d chars) = %q, should never return D or XL", len(desc), size)
		}
	}
}

func TestValidateBugfixSubstantiveContent(t *testing.T) {
	t.Parallel()

	t.Run("template_only_fails", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "bugfix-template"}
		os.MkdirAll(sd.Dir(), 0o755)

		// Bugfix with only template headings and short placeholder text.
		bugfix := "# Bugfix\n\n## Bug Summary\n{summary}\n\n## Severity & Impact\n{impact}\n\n## Reproduction Steps\n{steps}\n"
		os.WriteFile(sd.FilePath(FileBugfix), []byte(bugfix), 0o644)

		report, _ := Validate(sd, SizeM, TypeBugfix)
		assertCheckStatus(t, report, "min_fr_count", "fail")
	})

	t.Run("substantive_content_passes", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "bugfix-real"}
		os.MkdirAll(sd.Dir(), 0o755)

		bugfix := "# Bugfix\n\n## Bug Summary\nNull pointer exception when validating empty spec files in production\n\n## Severity & Impact\nP1 - affects all users running validation on newly created specs\n\n## Reproduction Steps\n1. Create a new spec with dossier init\n2. Run dossier validate immediately\n3. Observe crash in checkMinFRCount\n"
		os.WriteFile(sd.FilePath(FileBugfix), []byte(bugfix), 0o644)

		report, _ := Validate(sd, SizeM, TypeBugfix)
		assertCheckStatus(t, report, "min_fr_count", "pass")
	})
}

// --- v7: Grounding and delta traceability tests ---

func TestValidateGroundingCoverage(t *testing.T) {
	t.Parallel()

	t.Run("all_grounded_passes", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "grounding-test"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := `# Requirements
## Goal
<!-- confidence: 9 | source: user | grounding: verified -->
Test

## Functional Requirements
### FR-1: First
<!-- confidence: 8 | source: code | grounding: verified -->
WHEN x, the system SHALL y.

### FR-2: Second
<!-- confidence: 7 | source: inference | grounding: inferred -->
WHEN a, the system SHALL b.
`
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckStatus(t, report, "grounding_coverage", "pass")
	})

	t.Run("legacy_no_grounding_auto_pass", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "legacy-test"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := `# Requirements
## Goal
<!-- confidence: 9 | source: user -->
Test

## Functional Requirements
### FR-1: First
<!-- confidence: 8 | source: code -->
WHEN x, the system SHALL y.
`
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckMessageContains(t, report, "grounding_coverage", "pass", "opt-in")
	})

	t.Run("speculative_over_30pct_fails", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "spec-test"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := `# Requirements
## Goal
<!-- confidence: 9 | source: user | grounding: verified -->
Test

## Functional Requirements
### FR-1: First
<!-- confidence: 8 | source: code | grounding: speculative -->

### FR-2: Second
<!-- confidence: 7 | source: inference | grounding: speculative -->

### FR-3: Third
<!-- confidence: 6 | source: code | grounding: verified -->
`
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckMessageContains(t, report, "grounding_coverage", "fail", "speculative")
	})

	t.Run("m_size_skipped", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "m-test"}
		os.MkdirAll(sd.Dir(), 0o755)

		reqs := `# Requirements
## Goal
<!-- confidence: 9 | source: user | grounding: verified -->
Test
`
		os.WriteFile(sd.FilePath(FileRequirements), []byte(reqs), 0o644)
		report, _ := Validate(sd, SizeM, TypeFeature)
		assertCheckAbsent(t, report, "grounding_coverage")
	})

	t.Run("delta_chg_grounding", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "delta-g-test"}
		os.MkdirAll(sd.Dir(), 0o755)

		delta := `# Delta
## Change Summary
<!-- confidence: 8 | source: code | grounding: verified -->
Test change

## Files Affected
- CHG-1: ` + "`file.go`" + ` — change
  <!-- confidence: 8 | source: code | grounding: verified -->
- CHG-2: ` + "`other.go`" + ` — change
  <!-- confidence: 7 | source: code | grounding: inferred -->

## Before / After
### CHG-1: test
**Before:** old
**After:** new

## Test Plan
- [x] go test
`
		os.WriteFile(sd.FilePath(FileDelta), []byte(delta), 0o644)
		report, _ := Validate(sd, SizeDelta, TypeDelta)
		assertCheckStatus(t, report, "grounding_coverage", "pass")
	})
}

func TestValidateDeltaChangeIDs(t *testing.T) {
	t.Parallel()

	t.Run("has_chg_ids", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "chg-test"}
		os.MkdirAll(sd.Dir(), 0o755)

		delta := `# Delta
## Change Summary
Test

## Files Affected
- CHG-1: ` + "`file.go`" + ` — modify
- CHG-2: ` + "`other.go`" + ` — add

## Before / After
### CHG-1: test
**Before:** old
**After:** new

## Test Plan
- [x] tests pass
`
		os.WriteFile(sd.FilePath(FileDelta), []byte(delta), 0o644)
		report, _ := Validate(sd, SizeDelta, TypeDelta)
		assertCheckStatus(t, report, "delta_change_ids", "pass")
	})

	t.Run("no_chg_ids_fails", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "no-chg-test"}
		os.MkdirAll(sd.Dir(), 0o755)

		delta := `# Delta
## Change Summary
Test

## Files Affected
- ` + "`file.go`" + ` — modify (old format, no CHG-N)

## Before / After
Old and new behavior

## Test Plan
- [x] tests pass
`
		os.WriteFile(sd.FilePath(FileDelta), []byte(delta), 0o644)
		report, _ := Validate(sd, SizeDelta, TypeDelta)
		assertCheckStatus(t, report, "delta_change_ids", "fail")
	})

	t.Run("non_delta_skipped", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "feat-test"}
		os.MkdirAll(sd.Dir(), 0o755)

		report, _ := Validate(sd, SizeL, TypeFeature)
		assertCheckAbsent(t, report, "delta_change_ids")
	})
}

func TestValidateDeltaBeforeAfter(t *testing.T) {
	t.Parallel()

	t.Run("has_content_passes", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "ba-test"}
		os.MkdirAll(sd.Dir(), 0o755)

		delta := `# Delta
## Change Summary
Test

## Files Affected
- CHG-1: ` + "`file.go`" + ` — modify

## Before / After
### CHG-1: behavior change
**Before:** Returns nil error when input is empty
**After:** Returns ErrEmptyInput when input is empty

## Test Plan
- [x] tests pass
`
		os.WriteFile(sd.FilePath(FileDelta), []byte(delta), 0o644)
		report, _ := Validate(sd, SizeDelta, TypeDelta)
		assertCheckStatus(t, report, "delta_before_after", "pass")
	})

	t.Run("missing_section_fails", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "no-ba-test"}
		os.MkdirAll(sd.Dir(), 0o755)

		delta := `# Delta
## Change Summary
Test

## Files Affected
- CHG-1: ` + "`file.go`" + ` — modify

## Test Plan
- [x] tests pass
`
		os.WriteFile(sd.FilePath(FileDelta), []byte(delta), 0o644)
		report, _ := Validate(sd, SizeDelta, TypeDelta)
		assertCheckStatus(t, report, "delta_before_after", "fail")
	})

	t.Run("empty_section_fails", func(t *testing.T) {
		t.Parallel()
		tmp := t.TempDir()
		sd := &SpecDir{ProjectPath: tmp, TaskSlug: "empty-ba"}
		os.MkdirAll(sd.Dir(), 0o755)

		delta := `# Delta
## Change Summary
Test

## Files Affected
- CHG-1: ` + "`file.go`" + ` — modify

## Before / After

## Test Plan
- [x] tests pass
`
		os.WriteFile(sd.FilePath(FileDelta), []byte(delta), 0o644)
		report, _ := Validate(sd, SizeDelta, TypeDelta)
		assertCheckStatus(t, report, "delta_before_after", "fail")
	})
}
