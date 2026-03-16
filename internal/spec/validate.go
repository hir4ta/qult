package spec

import (
	"fmt"
	"regexp"
	"strings"
)

// ValidationCheck represents a single validation result.
type ValidationCheck struct {
	Name    string `json:"name"`
	Status  string `json:"status"` // "pass" or "fail"
	Message string `json:"message"`
}

// ValidationReport holds the complete validation result.
type ValidationReport struct {
	TaskSlug string            `json:"task_slug"`
	Size     SpecSize          `json:"size"`
	SpecType SpecType          `json:"spec_type"`
	Checks   []ValidationCheck `json:"checks"`
	Summary  string            `json:"summary"`
}

// Validate performs structural completeness checking on a spec.
// It is progressive: checks what exists and reports pass/fail per check.
func Validate(sd *SpecDir, size SpecSize, specType SpecType) (*ValidationReport, error) {
	report := &ValidationReport{
		TaskSlug: sd.TaskSlug,
		Size:     size,
		SpecType: specType,
	}

	// Determine the primary file (requirements.md or bugfix.md).
	primaryFile := FileRequirements
	if specType == TypeBugfix {
		primaryFile = FileBugfix
	}

	// 1. required_sections: ## Goal (or ## Bug Summary for bugfix) present in primary file.
	report.Checks = append(report.Checks, checkRequiredSections(sd, primaryFile, specType))

	// 2. min_fr_count: FR count by size.
	report.Checks = append(report.Checks, checkMinFRCount(sd, primaryFile, size, specType))

	// 3. traceability_fr_to_task: FR-N mapped to T-N.N in design.md.
	if c := checkFRToTask(sd, primaryFile, size); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// 4. traceability_task_to_fr: T-N.N references valid FR-N in tasks.md.
	if c := checkTaskToFR(sd, primaryFile, size); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// 5. confidence_annotations: at least one confidence annotation.
	report.Checks = append(report.Checks, checkConfidenceAnnotations(sd, primaryFile))

	// 6. closing_wave: "## Wave: Closing" present in tasks.md.
	report.Checks = append(report.Checks, checkClosingWave(sd))

	// Summary.
	passed := 0
	for _, c := range report.Checks {
		if c.Status == "pass" {
			passed++
		}
	}
	report.Summary = fmt.Sprintf("%d/%d checks passed", passed, len(report.Checks))

	return report, nil
}

// checkRequiredSections checks that the primary file has the expected heading.
func checkRequiredSections(sd *SpecDir, primaryFile SpecFile, specType SpecType) ValidationCheck {
	content, err := sd.ReadFile(primaryFile)
	if err != nil {
		return ValidationCheck{
			Name:    "required_sections",
			Status:  "fail",
			Message: fmt.Sprintf("%s not found", primaryFile),
		}
	}

	heading := "## Goal"
	if specType == TypeBugfix {
		heading = "## Bug Summary"
	}

	if strings.Contains(content, heading) {
		return ValidationCheck{
			Name:    "required_sections",
			Status:  "pass",
			Message: fmt.Sprintf("%s contains %s", primaryFile, heading),
		}
	}
	return ValidationCheck{
		Name:    "required_sections",
		Status:  "fail",
		Message: fmt.Sprintf("%s missing %s section", primaryFile, heading),
	}
}

var frPattern = regexp.MustCompile(`### FR-\d+`)

// checkMinFRCount checks the minimum number of FRs based on size.
func checkMinFRCount(sd *SpecDir, primaryFile SpecFile, size SpecSize, specType SpecType) ValidationCheck {
	minFR := 1
	switch size {
	case SizeM:
		minFR = 3
	case SizeL, SizeXL:
		minFR = 5
	}

	// For bugfix specs, check bugfix.md sections instead (they don't use FR-N).
	if specType == TypeBugfix {
		content, err := sd.ReadFile(primaryFile)
		if err != nil {
			return ValidationCheck{
				Name:    "min_fr_count",
				Status:  "fail",
				Message: fmt.Sprintf("%s not found", primaryFile),
			}
		}
		// Bugfix uses sections instead of FR-N identifiers.
		// Count ## sections as requirements (Bug Summary, etc.).
		sections := strings.Count(content, "\n## ")
		if sections >= minFR {
			return ValidationCheck{
				Name:    "min_fr_count",
				Status:  "pass",
				Message: fmt.Sprintf("%d sections found (minimum %d for size %s)", sections, minFR, size),
			}
		}
		return ValidationCheck{
			Name:    "min_fr_count",
			Status:  "fail",
			Message: fmt.Sprintf("%d sections found, minimum %d for size %s", sections, minFR, size),
		}
	}

	content, err := sd.ReadFile(primaryFile)
	if err != nil {
		return ValidationCheck{
			Name:    "min_fr_count",
			Status:  "fail",
			Message: fmt.Sprintf("%s not found", primaryFile),
		}
	}

	frCount := len(frPattern.FindAllString(content, -1))
	if frCount >= minFR {
		return ValidationCheck{
			Name:    "min_fr_count",
			Status:  "pass",
			Message: fmt.Sprintf("%d FRs found (minimum %d for size %s)", frCount, minFR, size),
		}
	}
	return ValidationCheck{
		Name:    "min_fr_count",
		Status:  "fail",
		Message: fmt.Sprintf("%d FRs found, minimum %d for size %s", frCount, minFR, size),
	}
}

var frIDPattern = regexp.MustCompile(`FR-(\d+)`)
var taskIDPattern = regexp.MustCompile(`T-(\d+)\.(\d+)`)

// checkFRToTask checks that FRs in the primary file are mapped to tasks in design.md.
// Skipped if no design.md exists.
func checkFRToTask(sd *SpecDir, primaryFile SpecFile, size SpecSize) *ValidationCheck {
	if size == SizeS {
		return nil // skip for S-size (no design.md)
	}

	design, err := sd.ReadFile(FileDesign)
	if err != nil {
		return nil // skip if no design.md
	}

	primary, err := sd.ReadFile(primaryFile)
	if err != nil {
		return nil
	}

	// Extract FR-N from primary file.
	frIDs := frIDPattern.FindAllString(primary, -1)
	if len(frIDs) == 0 {
		return nil // no FRs to check
	}

	// Check which FRs appear in design.md traceability.
	unmapped := []string{}
	for _, fr := range frIDs {
		if !strings.Contains(design, fr) {
			unmapped = append(unmapped, fr)
		}
	}

	// Deduplicate.
	seen := map[string]bool{}
	deduped := []string{}
	for _, fr := range unmapped {
		if !seen[fr] {
			seen[fr] = true
			deduped = append(deduped, fr)
		}
	}

	if len(deduped) == 0 {
		return &ValidationCheck{
			Name:    "traceability_fr_to_task",
			Status:  "pass",
			Message: "all FRs mapped in design.md",
		}
	}
	return &ValidationCheck{
		Name:    "traceability_fr_to_task",
		Status:  "fail",
		Message: fmt.Sprintf("unmapped FRs in design.md: %s", strings.Join(deduped, ", ")),
	}
}

// checkTaskToFR checks that tasks reference valid FRs.
// Skipped if no tasks.md exists.
func checkTaskToFR(sd *SpecDir, primaryFile SpecFile, size SpecSize) *ValidationCheck {
	tasks, err := sd.ReadFile(FileTasks)
	if err != nil {
		return nil // skip if no tasks.md
	}

	primary, err := sd.ReadFile(primaryFile)
	if err != nil {
		return nil
	}

	// Extract FR-N from primary file.
	frSet := map[string]bool{}
	for _, m := range frIDPattern.FindAllString(primary, -1) {
		frSet[m] = true
	}
	if len(frSet) == 0 {
		return nil // no FRs to validate against
	}

	// Find FR-N references in tasks.md.
	taskFRs := frIDPattern.FindAllString(tasks, -1)
	invalid := []string{}
	seen := map[string]bool{}
	for _, fr := range taskFRs {
		if !frSet[fr] && !seen[fr] {
			seen[fr] = true
			invalid = append(invalid, fr)
		}
	}

	if len(invalid) == 0 {
		return &ValidationCheck{
			Name:    "traceability_task_to_fr",
			Status:  "pass",
			Message: "all task FR references are valid",
		}
	}
	return &ValidationCheck{
		Name:    "traceability_task_to_fr",
		Status:  "fail",
		Message: fmt.Sprintf("invalid FR references in tasks.md: %s", strings.Join(invalid, ", ")),
	}
}

var confidencePattern = regexp.MustCompile(`<!--\s*confidence:\s*\d`)

// checkConfidenceAnnotations checks that at least one confidence annotation exists.
func checkConfidenceAnnotations(sd *SpecDir, primaryFile SpecFile) ValidationCheck {
	content, err := sd.ReadFile(primaryFile)
	if err != nil {
		return ValidationCheck{
			Name:    "confidence_annotations",
			Status:  "fail",
			Message: fmt.Sprintf("%s not found", primaryFile),
		}
	}

	if confidencePattern.MatchString(content) {
		return ValidationCheck{
			Name:    "confidence_annotations",
			Status:  "pass",
			Message: "confidence annotations found",
		}
	}
	return ValidationCheck{
		Name:    "confidence_annotations",
		Status:  "fail",
		Message: fmt.Sprintf("no confidence annotations in %s", primaryFile),
	}
}

// checkClosingWave checks that tasks.md contains a closing wave.
func checkClosingWave(sd *SpecDir) ValidationCheck {
	content, err := sd.ReadFile(FileTasks)
	if err != nil {
		return ValidationCheck{
			Name:    "closing_wave",
			Status:  "fail",
			Message: "tasks.md not found",
		}
	}

	if strings.Contains(content, "## Wave: Closing") {
		return ValidationCheck{
			Name:    "closing_wave",
			Status:  "pass",
			Message: "closing wave present in tasks.md",
		}
	}
	return ValidationCheck{
		Name:    "closing_wave",
		Status:  "fail",
		Message: "tasks.md missing '## Wave: Closing' section",
	}
}
