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

	// Determine the primary file based on spec type.
	primaryFile := FileRequirements
	switch specType {
	case TypeBugfix:
		primaryFile = FileBugfix
	case TypeDelta:
		primaryFile = FileDelta
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

	// 7. design_fr_references: FR-N in design.md must exist in primary file.
	if c := checkDesignFRReferences(sd, primaryFile, size); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// 8. testspec_fr_references: FR-N in test-specs.md must exist in primary file.
	if c := checkTestSpecFRReferences(sd, primaryFile); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// 9. nfr_traceability: NFR-N in primary mapped in design.md (L/XL only).
	if c := checkNFRTraceability(sd, primaryFile, size); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// 10. gherkin_syntax: ```gherkin blocks must contain Given+When+Then.
	if c := checkGherkinSyntax(sd); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// 11. orphan_tests: TS-N.N source annotations must reference defined FRs.
	if c := checkOrphanTests(sd, primaryFile); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// 12. orphan_tasks: task Requirements FR-N must reference defined FRs.
	if c := checkOrphanTasks(sd, primaryFile); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// --- v6: Content quality checks ---

	// 13. content_placeholder: FR titles must not be placeholder text.
	if c := checkContentPlaceholders(sd, primaryFile, specType); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// 14. decisions_completeness: DEC entries must have required fields (L/XL only).
	if c := checkDecisionsCompleteness(sd, size); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// 15. research_completeness: required sections must have content (L/XL only).
	if c := checkResearchCompleteness(sd, size); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// 16. confidence_coverage: all FRs must have confidence annotations (XL only).
	if c := checkConfidenceCoverage(sd, primaryFile, size); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// 17. xl_wave_count: tasks.md must have ≥4 numbered waves (XL only).
	if c := checkXLWaveCount(sd, size); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// 18. xl_nfr_required: at least one NFR-N must be defined (XL only).
	if c := checkXLNFRRequired(sd, primaryFile, size); c != nil {
		report.Checks = append(report.Checks, *c)
	}

	// 19. delta_sections_present: delta.md must have required sections (D only).
	if c := checkDeltaSections(sd, size); c != nil {
		report.Checks = append(report.Checks, *c)
	}

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
	switch specType {
	case TypeBugfix:
		heading = "## Bug Summary"
	case TypeDelta:
		heading = "## Change Summary"
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

// frTitlePlaceholderRe matches FR titles that are placeholders (TBD, TODO, {template variable}).
var frTitlePlaceholderRe = regexp.MustCompile(`(?m)^### FR-\d+:\s*(?:TBD|TODO|\{[^}]+\})\s*$`)

// decSectionRe matches DEC-N section headers in decisions.md.
var decSectionRe = regexp.MustCompile(`(?m)^## DEC-\d+`)

// Decision required field patterns — each must have non-whitespace content after the colon.
var decStatusRe = regexp.MustCompile(`(?m)^\s*-\s*\*\*Status\*\*:\s*\S`)
var decContextRe = regexp.MustCompile(`(?m)^\s*-\s*\*\*Context\*\*:\s*\S`)
var decChosenRe = regexp.MustCompile(`(?m)^\s*-\s*\*\*Chosen\*\*:\s*\S`)
var decRationaleRe = regexp.MustCompile(`(?m)^\s*-\s*\*\*Rationale\*\*:\s*\S`)

// numberedWaveRe matches numbered wave headers (excluding Closing).
var numberedWaveRe = regexp.MustCompile(`(?m)^## Wave\s+\d+`)

// checkMinFRCount checks the minimum number of FRs based on size.
func checkMinFRCount(sd *SpecDir, primaryFile SpecFile, size SpecSize, specType SpecType) ValidationCheck {
	minFR := 1
	switch size {
	case SizeM:
		minFR = 3
	case SizeL:
		minFR = 5
	case SizeXL:
		minFR = 8
	}

	// For bugfix specs, count sections with substantive content (not just headings).
	if specType == TypeBugfix {
		content, err := sd.ReadFile(primaryFile)
		if err != nil {
			return ValidationCheck{
				Name:    "min_fr_count",
				Status:  "fail",
				Message: fmt.Sprintf("%s not found", primaryFile),
			}
		}
		substantive := countSubstantiveSections(content)
		if substantive >= minFR {
			return ValidationCheck{
				Name:    "min_fr_count",
				Status:  "pass",
				Message: fmt.Sprintf("%d substantive sections found (minimum %d for size %s)", substantive, minFR, size),
			}
		}
		return ValidationCheck{
			Name:    "min_fr_count",
			Status:  "fail",
			Message: fmt.Sprintf("%d substantive sections found, minimum %d for size %s", substantive, minFR, size),
		}
	}

	// Delta specs don't use FR-N — skip this check entirely.
	if specType == TypeDelta {
		return ValidationCheck{
			Name:    "min_fr_count",
			Status:  "pass",
			Message: "skipped for delta specs",
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
var nfrIDPattern = regexp.MustCompile(`NFR-(\d+)`)
var taskIDPattern = regexp.MustCompile(`T-(\d+)\.(\d+)`)
var gherkinBlockPattern = regexp.MustCompile("(?s)```gherkin\\s*\\n(.*?)```")
var gherkinGivenPattern = regexp.MustCompile(`(?m)^\s*Given\s+`)
var gherkinWhenPattern = regexp.MustCompile(`(?m)^\s*When\s+`)
var gherkinThenPattern = regexp.MustCompile(`(?m)^\s*Then\s+`)
var sourceCommentPattern = regexp.MustCompile(`<!--\s*source:\s*FR-(\d+)`)
var taskReqPattern = regexp.MustCompile(`Requirements:\s*(FR-\d+(?:\s*,\s*FR-\d+)*)`)

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

// extractFRSet extracts unique FR-N identifiers from content and returns them as a set.
func extractFRSet(content string) map[string]bool {
	set := map[string]bool{}
	for _, m := range frIDPattern.FindAllString(content, -1) {
		set[m] = true
	}
	return set
}

// checkDesignFRReferences checks that FR-N references in design.md exist in the primary file.
// Skipped if no design.md or primary file.
func checkDesignFRReferences(sd *SpecDir, primaryFile SpecFile, size SpecSize) *ValidationCheck {
	if size == SizeS {
		return nil
	}

	design, err := sd.ReadFile(FileDesign)
	if err != nil {
		return nil
	}

	primary, err := sd.ReadFile(primaryFile)
	if err != nil {
		return nil
	}

	definedFRs := extractFRSet(primary)
	if len(definedFRs) == 0 {
		return nil
	}

	designFRs := frIDPattern.FindAllString(design, -1)
	seen := map[string]bool{}
	var invalid []string
	for _, fr := range designFRs {
		if !definedFRs[fr] && !seen[fr] {
			seen[fr] = true
			invalid = append(invalid, fr)
		}
	}

	if len(invalid) == 0 {
		return &ValidationCheck{
			Name:    "design_fr_references",
			Status:  "pass",
			Message: "all FR references in design.md are valid",
		}
	}
	return &ValidationCheck{
		Name:    "design_fr_references",
		Status:  "fail",
		Message: fmt.Sprintf("undefined FR references in design.md: %s", strings.Join(invalid, ", ")),
	}
}

// checkTestSpecFRReferences checks that FR-N references in test-specs.md exist in the primary file.
// Skipped if no test-specs.md or primary file.
func checkTestSpecFRReferences(sd *SpecDir, primaryFile SpecFile) *ValidationCheck {
	testSpecs, err := sd.ReadFile(FileTestSpecs)
	if err != nil {
		return nil
	}

	primary, err := sd.ReadFile(primaryFile)
	if err != nil {
		return nil
	}

	definedFRs := extractFRSet(primary)
	if len(definedFRs) == 0 {
		return nil
	}

	testFRs := frIDPattern.FindAllString(testSpecs, -1)
	seen := map[string]bool{}
	var invalid []string
	for _, fr := range testFRs {
		if !definedFRs[fr] && !seen[fr] {
			seen[fr] = true
			invalid = append(invalid, fr)
		}
	}

	if len(invalid) == 0 {
		return &ValidationCheck{
			Name:    "testspec_fr_references",
			Status:  "pass",
			Message: "all FR references in test-specs.md are valid",
		}
	}
	return &ValidationCheck{
		Name:    "testspec_fr_references",
		Status:  "fail",
		Message: fmt.Sprintf("undefined FR references in test-specs.md: %s", strings.Join(invalid, ", ")),
	}
}

// checkNFRTraceability checks that NFR-N in the primary file are mapped in design.md.
// Skipped if size is S/M, no design.md, or no NFR-N in primary.
func checkNFRTraceability(sd *SpecDir, primaryFile SpecFile, size SpecSize) *ValidationCheck {
	if size != SizeL && size != SizeXL {
		return nil
	}

	primary, err := sd.ReadFile(primaryFile)
	if err != nil {
		return nil
	}

	nfrIDs := nfrIDPattern.FindAllString(primary, -1)
	if len(nfrIDs) == 0 {
		return nil // no NFRs defined — skip
	}

	design, err := sd.ReadFile(FileDesign)
	if err != nil {
		return nil
	}

	seen := map[string]bool{}
	var unmapped []string
	for _, nfr := range nfrIDs {
		if seen[nfr] {
			continue
		}
		seen[nfr] = true
		if !strings.Contains(design, nfr) {
			unmapped = append(unmapped, nfr)
		}
	}

	if len(unmapped) == 0 {
		return &ValidationCheck{
			Name:    "nfr_traceability",
			Status:  "pass",
			Message: "all NFRs mapped in design.md",
		}
	}
	return &ValidationCheck{
		Name:    "nfr_traceability",
		Status:  "fail",
		Message: fmt.Sprintf("unmapped NFRs in design.md: %s", strings.Join(unmapped, ", ")),
	}
}

// checkGherkinSyntax checks that ```gherkin blocks in test-specs.md contain Given+When+Then.
// Skipped if no test-specs.md or no gherkin blocks found.
func checkGherkinSyntax(sd *SpecDir) *ValidationCheck {
	content, err := sd.ReadFile(FileTestSpecs)
	if err != nil {
		return nil
	}

	blocks := gherkinBlockPattern.FindAllStringSubmatch(content, -1)
	if len(blocks) == 0 {
		return nil // no gherkin blocks — skip
	}

	var incomplete []int
	for i, block := range blocks {
		body := block[1]
		hasGiven := gherkinGivenPattern.MatchString(body)
		hasWhen := gherkinWhenPattern.MatchString(body)
		hasThen := gherkinThenPattern.MatchString(body)
		if !hasGiven || !hasWhen || !hasThen {
			incomplete = append(incomplete, i+1)
		}
	}

	if len(incomplete) == 0 {
		return &ValidationCheck{
			Name:    "gherkin_syntax",
			Status:  "pass",
			Message: fmt.Sprintf("all %d gherkin blocks have Given/When/Then", len(blocks)),
		}
	}

	nums := make([]string, len(incomplete))
	for i, n := range incomplete {
		nums[i] = fmt.Sprintf("#%d", n)
	}
	return &ValidationCheck{
		Name:    "gherkin_syntax",
		Status:  "fail",
		Message: fmt.Sprintf("gherkin blocks missing Given/When/Then: %s", strings.Join(nums, ", ")),
	}
}

// checkOrphanTests checks that test source annotations (<!-- source: FR-N -->)
// in test-specs.md reference FRs defined in the primary file.
// Skipped if no test-specs.md or no source annotations.
func checkOrphanTests(sd *SpecDir, primaryFile SpecFile) *ValidationCheck {
	testSpecs, err := sd.ReadFile(FileTestSpecs)
	if err != nil {
		return nil
	}

	primary, err := sd.ReadFile(primaryFile)
	if err != nil {
		return nil
	}

	definedFRs := extractFRSet(primary)
	if len(definedFRs) == 0 {
		return nil
	}

	sourceMatches := sourceCommentPattern.FindAllStringSubmatch(testSpecs, -1)
	if len(sourceMatches) == 0 {
		return nil // no source annotations — skip
	}

	seen := map[string]bool{}
	var orphans []string
	for _, m := range sourceMatches {
		frRef := "FR-" + m[1]
		if !definedFRs[frRef] && !seen[frRef] {
			seen[frRef] = true
			orphans = append(orphans, frRef)
		}
	}

	if len(orphans) == 0 {
		return &ValidationCheck{
			Name:    "orphan_tests",
			Status:  "pass",
			Message: "all test source annotations reference valid FRs",
		}
	}
	return &ValidationCheck{
		Name:    "orphan_tests",
		Status:  "fail",
		Message: fmt.Sprintf("orphan test references: %s", strings.Join(orphans, ", ")),
	}
}

// countSubstantiveSections counts ## sections that contain at least one line
// with ≥10 non-whitespace characters (excluding HTML comments).
// Used for bugfix specs where FR-N identifiers are not used.
func countSubstantiveSections(content string) int {
	sections := strings.Split(content, "\n## ")
	count := 0
	for i, section := range sections {
		if i == 0 {
			// First section is before any ## heading (title area).
			// Check for # heading content.
			if !strings.HasPrefix(strings.TrimSpace(section), "#") {
				continue
			}
		}
		if hasSubstantiveContent(section) {
			count++
		}
	}
	return count
}

// hasSubstantiveContent returns true if the section body (after the first line/heading)
// contains at least one line with ≥10 non-whitespace characters, excluding HTML comments.
func hasSubstantiveContent(section string) bool {
	lines := strings.Split(section, "\n")
	inComment := false
	for _, line := range lines[1:] { // skip heading line
		trimmed := strings.TrimSpace(line)
		// Track HTML comment blocks.
		if strings.Contains(trimmed, "<!--") {
			inComment = true
		}
		if strings.Contains(trimmed, "-->") {
			inComment = false
			continue
		}
		if inComment {
			continue
		}
		// Count non-whitespace characters.
		nonWS := 0
		for _, r := range trimmed {
			if r != ' ' && r != '\t' {
				nonWS++
			}
		}
		if nonWS >= 10 {
			return true
		}
	}
	return false
}

// checkContentPlaceholders checks that FR titles are not placeholder text (TBD, TODO, {template}).
// Skipped for bugfix/delta specs (they don't use FR-N).
func checkContentPlaceholders(sd *SpecDir, primaryFile SpecFile, specType SpecType) *ValidationCheck {
	if specType == TypeBugfix || specType == TypeDelta {
		return nil
	}

	content, err := sd.ReadFile(primaryFile)
	if err != nil {
		return nil
	}

	// Strip HTML comment blocks to avoid false positives on examples.
	stripped := stripHTMLComments(content)

	matches := frTitlePlaceholderRe.FindAllString(stripped, -1)
	if len(matches) == 0 {
		return &ValidationCheck{
			Name:    "content_placeholder",
			Status:  "pass",
			Message: "no placeholder FR titles found",
		}
	}

	// Extract FR IDs from placeholder matches.
	var placeholderFRs []string
	for _, m := range matches {
		if ids := frIDPattern.FindString(m); ids != "" {
			placeholderFRs = append(placeholderFRs, ids)
		}
	}

	return &ValidationCheck{
		Name:    "content_placeholder",
		Status:  "fail",
		Message: fmt.Sprintf("placeholder FR titles: %s", strings.Join(placeholderFRs, ", ")),
	}
}

// stripHTMLComments removes <!-- ... --> blocks from content.
func stripHTMLComments(content string) string {
	var result strings.Builder
	i := 0
	for i < len(content) {
		if i+4 <= len(content) && content[i:i+4] == "<!--" {
			end := strings.Index(content[i:], "-->")
			if end >= 0 {
				i += end + 3
				continue
			}
		}
		result.WriteByte(content[i])
		i++
	}
	return result.String()
}

// checkDecisionsCompleteness checks that DEC-N entries in decisions.md have required fields.
// Skipped for S/M sizes or if decisions.md doesn't exist.
func checkDecisionsCompleteness(sd *SpecDir, size SpecSize) *ValidationCheck {
	if size == SizeS || size == SizeM || size == SizeDelta {
		return nil
	}

	content, err := sd.ReadFile(FileDecisions)
	if err != nil {
		return nil
	}

	// Split into DEC sections.
	sections := decSectionRe.Split(content, -1)
	headers := decSectionRe.FindAllString(content, -1)
	if len(headers) == 0 {
		return &ValidationCheck{
			Name:    "decisions_completeness",
			Status:  "fail",
			Message: "no DEC-N entries found in decisions.md",
		}
	}

	type fieldCheck struct {
		name string
		re   *regexp.Regexp
	}
	requiredFields := []fieldCheck{
		{"Status", decStatusRe},
		{"Context", decContextRe},
		{"Chosen", decChosenRe},
		{"Rationale", decRationaleRe},
	}

	var incomplete []string
	for i, header := range headers {
		body := ""
		if i+1 < len(sections) {
			body = sections[i+1]
		}
		var missing []string
		for _, f := range requiredFields {
			if !f.re.MatchString(body) {
				missing = append(missing, f.name)
			}
		}
		if len(missing) > 0 {
			// Extract DEC-N from header.
			decID := strings.TrimSpace(header)
			decID = strings.TrimPrefix(decID, "## ")
			if idx := strings.Index(decID, ":"); idx > 0 {
				decID = decID[:idx]
			}
			incomplete = append(incomplete, fmt.Sprintf("%s: missing %s", decID, strings.Join(missing, ", ")))
		}
	}

	if len(incomplete) == 0 {
		return &ValidationCheck{
			Name:    "decisions_completeness",
			Status:  "pass",
			Message: fmt.Sprintf("all %d DEC entries have required fields", len(headers)),
		}
	}
	return &ValidationCheck{
		Name:    "decisions_completeness",
		Status:  "fail",
		Message: strings.Join(incomplete, "; "),
	}
}

// researchRequiredSections lists the sections that must have content in research.md.
var researchRequiredSections = []string{
	"## Discovery Summary",
	"## Gap Analysis",
	"## Implementation Options",
	"## Done Criteria",
}

// checkResearchCompleteness checks that research.md has content in required sections.
// Skipped for S/M sizes or if research.md doesn't exist.
func checkResearchCompleteness(sd *SpecDir, size SpecSize) *ValidationCheck {
	if size == SizeS || size == SizeM || size == SizeDelta {
		return nil
	}

	content, err := sd.ReadFile(FileResearch)
	if err != nil {
		return nil
	}

	var empty []string
	for _, heading := range researchRequiredSections {
		if !strings.Contains(content, heading) {
			empty = append(empty, heading)
			continue
		}
		// Extract section body and check for substantive content.
		sectionBody := extractSectionBody(content, heading)
		if !hasSubstantiveContent(heading + "\n" + sectionBody) {
			empty = append(empty, heading)
		}
	}

	if len(empty) == 0 {
		return &ValidationCheck{
			Name:    "research_completeness",
			Status:  "pass",
			Message: "all required research sections have content",
		}
	}
	return &ValidationCheck{
		Name:    "research_completeness",
		Status:  "fail",
		Message: fmt.Sprintf("research sections missing content: %s", strings.Join(empty, ", ")),
	}
}

// extractSectionBody returns the content between a heading and the next ## heading.
func extractSectionBody(content, heading string) string {
	_, after, found := strings.Cut(content, heading)
	if !found {
		return ""
	}
	if nextSection, _, ok := strings.Cut(after, "\n## "); ok {
		return nextSection
	}
	return after
}

// checkConfidenceCoverage checks that every FR-N section has a confidence annotation.
// XL only — L and below use the existing single-annotation check.
func checkConfidenceCoverage(sd *SpecDir, primaryFile SpecFile, size SpecSize) *ValidationCheck {
	if size != SizeXL {
		return nil
	}

	content, err := sd.ReadFile(primaryFile)
	if err != nil {
		return nil
	}

	// Split content by FR-N headers and check each has confidence.
	frHeaders := frPattern.FindAllStringIndex(content, -1)
	if len(frHeaders) == 0 {
		return nil
	}

	var uncovered []string
	for i, loc := range frHeaders {
		// Extract section from this FR header to the next (or EOF).
		start := loc[0]
		end := len(content)
		if i+1 < len(frHeaders) {
			end = frHeaders[i+1][0]
		}
		section := content[start:end]

		frID := frIDPattern.FindString(section)
		if frID == "" {
			continue
		}

		if !confidencePattern.MatchString(section) {
			uncovered = append(uncovered, frID)
		}
	}

	if len(uncovered) == 0 {
		return &ValidationCheck{
			Name:    "confidence_coverage",
			Status:  "pass",
			Message: fmt.Sprintf("all %d FRs have confidence annotations", len(frHeaders)),
		}
	}
	return &ValidationCheck{
		Name:    "confidence_coverage",
		Status:  "fail",
		Message: fmt.Sprintf("FRs missing confidence: %s", strings.Join(uncovered, ", ")),
	}
}

// checkXLWaveCount checks that tasks.md has ≥4 numbered waves (XL only).
func checkXLWaveCount(sd *SpecDir, size SpecSize) *ValidationCheck {
	if size != SizeXL {
		return nil
	}

	content, err := sd.ReadFile(FileTasks)
	if err != nil {
		return nil
	}

	waves := numberedWaveRe.FindAllString(content, -1)
	count := len(waves)

	if count >= 4 {
		return &ValidationCheck{
			Name:    "xl_wave_count",
			Status:  "pass",
			Message: fmt.Sprintf("%d waves found (minimum 4 for XL)", count),
		}
	}
	return &ValidationCheck{
		Name:    "xl_wave_count",
		Status:  "fail",
		Message: fmt.Sprintf("%d waves found, minimum 4 for size XL", count),
	}
}

// checkXLNFRRequired checks that at least one NFR-N is defined (XL only).
func checkXLNFRRequired(sd *SpecDir, primaryFile SpecFile, size SpecSize) *ValidationCheck {
	if size != SizeXL {
		return nil
	}

	content, err := sd.ReadFile(primaryFile)
	if err != nil {
		return nil
	}

	nfrs := nfrIDPattern.FindAllString(content, -1)
	if len(nfrs) > 0 {
		// Deduplicate.
		seen := map[string]bool{}
		unique := 0
		for _, n := range nfrs {
			if !seen[n] {
				seen[n] = true
				unique++
			}
		}
		return &ValidationCheck{
			Name:    "xl_nfr_required",
			Status:  "pass",
			Message: fmt.Sprintf("%d NFRs defined", unique),
		}
	}
	return &ValidationCheck{
		Name:    "xl_nfr_required",
		Status:  "fail",
		Message: "no NFR-N entries found (required for XL specs)",
	}
}

// deltaRequiredSections lists the sections that must exist in delta.md.
var deltaRequiredSections = []string{
	"## Change Summary",
	"## Files Affected",
	"## Test Plan",
}

// checkDeltaSections checks that delta.md has required sections (D size only).
func checkDeltaSections(sd *SpecDir, size SpecSize) *ValidationCheck {
	if size != SizeDelta {
		return nil
	}

	content, err := sd.ReadFile(FileDelta)
	if err != nil {
		return nil
	}

	var missing []string
	for _, section := range deltaRequiredSections {
		if !strings.Contains(content, section) {
			missing = append(missing, section)
		}
	}

	if len(missing) == 0 {
		return &ValidationCheck{
			Name:    "delta_sections_present",
			Status:  "pass",
			Message: "all required delta sections present",
		}
	}
	return &ValidationCheck{
		Name:    "delta_sections_present",
		Status:  "fail",
		Message: fmt.Sprintf("missing delta sections: %s", strings.Join(missing, ", ")),
	}
}

// checkOrphanTasks checks that task Requirements FR-N references in tasks.md
// reference FRs defined in the primary file.
// This differs from checkTaskToFR: it checks _Requirements:_ lines specifically,
// while checkTaskToFR checks all FR-N references in the entire tasks.md.
// Skipped if no tasks.md or no primary file.
func checkOrphanTasks(sd *SpecDir, primaryFile SpecFile) *ValidationCheck {
	tasks, err := sd.ReadFile(FileTasks)
	if err != nil {
		return nil
	}

	primary, err := sd.ReadFile(primaryFile)
	if err != nil {
		return nil
	}

	definedFRs := extractFRSet(primary)
	if len(definedFRs) == 0 {
		return nil
	}

	// Extract FR-N from _Requirements: FR-N_ lines.
	reqMatches := taskReqPattern.FindAllStringSubmatch(tasks, -1)
	if len(reqMatches) == 0 {
		return nil
	}

	seen := map[string]bool{}
	var orphans []string
	for _, m := range reqMatches {
		// m[1] contains the FR references (e.g., "FR-1" or "FR-1, FR-2")
		frRefs := frIDPattern.FindAllString(m[1], -1)
		for _, fr := range frRefs {
			if !definedFRs[fr] && !seen[fr] {
				seen[fr] = true
				orphans = append(orphans, fr)
			}
		}
	}

	if len(orphans) == 0 {
		return &ValidationCheck{
			Name:    "orphan_tasks",
			Status:  "pass",
			Message: "all task requirement references are valid",
		}
	}
	return &ValidationCheck{
		Name:    "orphan_tasks",
		Status:  "fail",
		Message: fmt.Sprintf("orphan task FR references: %s", strings.Join(orphans, ", ")),
	}
}
