package main

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/spec"
)

// livingSpecAction is the audit action for Living Spec auto-updates.
const livingSpecAction = "living-spec.update"

// autoAppendSourceExtensions are file extensions eligible for auto-append.
var autoAppendSourceExtensions = []string{
	".go", ".ts", ".tsx", ".js", ".jsx",
	".py", ".rs", ".java", ".kt", ".swift",
	".rb", ".ex", ".exs", ".c", ".cpp", ".h",
}

// autoAppendExclusions are file suffixes excluded from auto-append.
var autoAppendExclusions = []string{
	"_test.go", "_gen.go", ".pb.go", "_mock.go", "_string.go",
	".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".spec.ts", ".spec.js",
	"_test.py", "_test.rs",
	".d.ts", ".min.js", ".min.css",
}

// autoAppendDirExclusions are directory prefixes excluded from auto-append.
var autoAppendDirExclusions = []string{
	"vendor/", "plugin/", ".alfred/",
	"node_modules/", "dist/", "build/", "__pycache__/", "target/",
}

// shouldAutoAppend returns true if the file is eligible for auto-append to design.md.
// Includes source code files, excludes tests, generated, vendor, and non-source files.
func shouldAutoAppend(filePath string) bool {
	isSource := false
	for _, ext := range autoAppendSourceExtensions {
		if strings.HasSuffix(filePath, ext) {
			isSource = true
			break
		}
	}
	if !isSource {
		return false
	}
	for _, excl := range autoAppendExclusions {
		if strings.HasSuffix(filePath, excl) {
			return false
		}
	}
	for _, dir := range autoAppendDirExclusions {
		if strings.HasPrefix(filePath, dir) {
			return false
		}
	}
	return true
}

// autoAppendCandidate tracks a file to append and its target component.
type autoAppendCandidate struct {
	filePath  string
	component string
}

// tryAutoAppendDesignRefs identifies untracked .go files matching known Components
// and appends them to design.md. Called BEFORE tryDetectSpecDrift so that
// auto-appended files are excluded from drift warnings.
// Returns set of appended file paths.
func tryAutoAppendDesignRefs(ctx context.Context, projectPath string, changed []string) map[string]bool {
	appended := make(map[string]bool)
	if projectPath == "" || len(changed) == 0 {
		return appended
	}

	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		return appended
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}

	// Read design.md for component file references.
	design, err := sd.ReadFile(spec.FileDesign)
	if err != nil {
		return appended
	}

	specRefs := make(map[string]string)
	parseDesignFileRefs(design, specRefs)
	if len(specRefs) == 0 {
		return appended
	}

	// Identify candidates: .go files matching a Component but not yet in design.md.
	var candidates []autoAppendCandidate

	for _, f := range changed {
		if !shouldAutoAppend(f) {
			continue
		}
		cleanPath := filepath.Clean(f)
		if _, exists := specRefs[cleanPath]; exists {
			continue
		}
		if _, exists := specRefs[f]; exists {
			continue
		}
		comp := matchComponentByPackage(f, specRefs)
		if comp == "" {
			continue
		}
		if !componentHasFileLines(design, comp) {
			continue // DEC-5: skip components with no existing File: lines
		}
		candidates = append(candidates, autoAppendCandidate{filePath: f, component: comp})
	}

	if len(candidates) == 0 {
		return appended
	}

	// Read-modify-write using WriteFile (handles lock + history + atomic write).
	// Re-read inside WriteFile's lock is not possible with current API,
	// but single-user + advisory lock makes TOCTOU risk acceptable for Phase 1.
	timestamp := time.Now().UTC().Format(time.RFC3339)
	updated := design

	for _, c := range candidates {
		newLine := fmt.Sprintf("- **File**: `%s` <!-- auto-added: %s -->", c.filePath, timestamp)
		result := insertAfterLastFileLine(updated, c.component, newLine)
		if result != updated {
			updated = result
			appended[c.filePath] = true
		}
	}

	if len(appended) == 0 {
		return appended
	}

	if err := sd.WriteFile(ctx, spec.FileDesign, updated); err != nil {
		notifyUser("living-spec: auto-append write failed: %v", err)
		return make(map[string]bool) // return empty on write failure
	}

	// Audit trail.
	componentSet := make(map[string]bool)
	for _, c := range candidates {
		if appended[c.filePath] {
			componentSet[c.component] = true
		}
	}
	components := make([]string, 0, len(componentSet))
	for c := range componentSet {
		components = append(components, c)
	}
	files := make([]string, 0, len(appended))
	for f := range appended {
		files = append(files, f)
	}
	detail, _ := json.Marshal(map[string]any{
		"files":      files,
		"components": components,
	})
	spec.AppendAudit(projectPath, spec.AuditEntry{
		Action: livingSpecAction,
		Target: taskSlug,
		Detail: string(detail),
		User:   "hook",
	})

	return appended
}

// fileLineRe matches "- **File**: `path`" or "- **File:** `path`" lines in design.md.
var fileLineRe = regexp.MustCompile(`(?i)^\s*-\s+\*\*File\*\*:?\s*`)

// componentHasFileLines checks if a named Component section has at least one **File**: line.
func componentHasFileLines(design, componentName string) bool {
	inComponent := false
	for _, line := range strings.Split(design, "\n") {
		trimmed := strings.TrimSpace(line)
		if m := componentNameRe.FindStringSubmatch(trimmed); len(m) > 1 {
			inComponent = strings.TrimSpace(m[1]) == componentName
			continue
		}
		if strings.HasPrefix(trimmed, "### ") && inComponent {
			return false
		}
		if inComponent && fileLineRe.MatchString(line) {
			return true
		}
	}
	return false
}

// insertAfterLastFileLine finds the last "- **File**:" line within the named
// Component section and inserts newLine after it. Returns the modified content,
// or original if the component or insertion point cannot be found.
func insertAfterLastFileLine(content, componentName, newLine string) string {
	lines := strings.Split(content, "\n")
	inComponent := false
	lastFileIdx := -1

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if m := componentNameRe.FindStringSubmatch(trimmed); len(m) > 1 {
			if inComponent && lastFileIdx >= 0 {
				break // we were in our component and found File: lines — done
			}
			inComponent = strings.TrimSpace(m[1]) == componentName
			lastFileIdx = -1
			continue
		}
		if strings.HasPrefix(trimmed, "### ") && inComponent {
			break
		}
		if inComponent && fileLineRe.MatchString(line) {
			lastFileIdx = i
		}
	}

	if lastFileIdx < 0 {
		return content
	}

	result := make([]string, 0, len(lines)+1)
	result = append(result, lines[:lastFileIdx+1]...)
	result = append(result, newLine)
	result = append(result, lines[lastFileIdx+1:]...)
	return strings.Join(result, "\n")
}
