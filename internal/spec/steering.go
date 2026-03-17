package spec

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/template"
)

//go:embed templates/steering/*.tmpl
var steeringFS embed.FS

// SteeringFile represents a steering document type.
type SteeringFile string

const (
	SteeringProduct   SteeringFile = "product.md"
	SteeringStructure SteeringFile = "structure.md"
	SteeringTech      SteeringFile = "tech.md"
)

// AllSteeringFiles lists all steering file types.
var AllSteeringFiles = []SteeringFile{SteeringProduct, SteeringStructure, SteeringTech}

// SteeringData holds values for steering template rendering.
type SteeringData struct {
	ProjectName  string
	Description  string
	TechStack    string   // e.g., "Go 1.25"
	Dependencies []string // key deps from go.mod/package.json
	Packages     []string // top-level directories/packages
	Conventions  []string // extracted from CLAUDE.md
	Date         string   // YYYY-MM-DD
}

// SteeringDir returns the .alfred/steering/ directory path.
func SteeringDir(projectPath string) string {
	return filepath.Join(projectPath, ".alfred", "steering")
}

// SteeringTemplatesDir returns the .alfred/templates/steering/ directory path.
func SteeringTemplatesDir(projectPath string) string {
	return filepath.Join(projectPath, ".alfred", "templates", "steering")
}

// SteeringExists returns true if the steering directory contains at least one file.
func SteeringExists(projectPath string) bool {
	dir := SteeringDir(projectPath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
			return true
		}
	}
	return false
}

// readSteeringTemplateRaw reads a steering template, checking user override first.
func readSteeringTemplateRaw(f SteeringFile, projectPath string) ([]byte, error) {
	if projectPath != "" {
		userPath := filepath.Join(SteeringTemplatesDir(projectPath), string(f)+".tmpl")
		if raw, err := os.ReadFile(userPath); err == nil {
			return raw, nil
		}
	}

	name := string(f) + ".tmpl"
	raw, err := steeringFS.ReadFile("templates/steering/" + name)
	if err != nil {
		return nil, fmt.Errorf("read steering template %s: %w", name, err)
	}
	return raw, nil
}

// RenderSteering renders all 3 steering templates.
// projectPath enables 2-layer template resolution (user override > embedded default).
func RenderSteering(data SteeringData, projectPath string) (map[SteeringFile]string, error) {
	result := make(map[SteeringFile]string, len(AllSteeringFiles))
	for _, f := range AllSteeringFiles {
		content, err := renderSteeringTemplate(f, data, projectPath)
		if err != nil {
			return nil, err
		}
		result[f] = content
	}
	return result, nil
}

// renderSteeringTemplate renders a single steering template with 2-layer resolution.
func renderSteeringTemplate(f SteeringFile, data SteeringData, projectPath string) (string, error) {
	raw, err := readSteeringTemplateRaw(f, projectPath)
	if err != nil {
		return "", err
	}

	name := string(f) + ".tmpl"
	tmpl, err := template.New(name).Parse(string(raw))
	if err != nil {
		return "", fmt.Errorf("parse steering template %s: %w", name, err)
	}

	var buf strings.Builder
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("execute steering template %s: %w", name, err)
	}
	return buf.String(), nil
}

// WriteSteering writes rendered steering files to the .alfred/steering/ directory.
// Returns an error if the directory already exists and force is false.
func WriteSteering(projectPath string, rendered map[SteeringFile]string, force bool) error {
	dir := SteeringDir(projectPath)
	if !force && SteeringExists(projectPath) {
		return fmt.Errorf("steering docs already exist in %s (use --force to overwrite)", dir)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create steering dir: %w", err)
	}
	for f, content := range rendered {
		path := filepath.Join(dir, string(f))
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", f, err)
		}
	}
	return nil
}

// ReadSteering reads all steering files, returning content map.
// Missing files are silently skipped (partial read is OK).
func ReadSteering(projectPath string) (map[SteeringFile]string, error) {
	dir := SteeringDir(projectPath)
	result := make(map[SteeringFile]string)
	for _, f := range AllSteeringFiles {
		data, err := os.ReadFile(filepath.Join(dir, string(f)))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return result, fmt.Errorf("read %s: %w", f, err)
		}
		result[f] = string(data)
	}
	return result, nil
}

// SteeringSummary returns a compact summary for injection into dossier init.
// Returns empty string if no steering docs exist.
func SteeringSummary(projectPath string) (string, error) {
	docs, err := ReadSteering(projectPath)
	if err != nil {
		return "", err
	}
	if len(docs) == 0 {
		return "", nil
	}

	var buf strings.Builder
	for _, f := range AllSteeringFiles {
		content, ok := docs[f]
		if !ok || strings.TrimSpace(content) == "" {
			continue
		}
		// Extract the first heading and non-empty lines as summary.
		buf.WriteString(fmt.Sprintf("### %s\n", f))
		lines := strings.Split(content, "\n")
		count := 0
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			// Skip comments and empty lines.
			if trimmed == "" || strings.HasPrefix(trimmed, "<!--") {
				continue
			}
			buf.WriteString(line + "\n")
			count++
			if count >= 15 {
				buf.WriteString("...\n")
				break
			}
		}
		buf.WriteString("\n")
	}
	return buf.String(), nil
}

// SteeringWarning represents a validation issue found in steering docs.
type SteeringWarning struct {
	File    SteeringFile
	Kind    string // "drift", "missing_dir", "stale"
	Message string
}

// ValidateSteering checks steering docs against project state.
// It compares tech.md against go.mod/package.json for dependency drift,
// and structure.md against the filesystem for missing directories.
func ValidateSteering(projectPath string) ([]SteeringWarning, error) {
	docs, err := ReadSteering(projectPath)
	if err != nil {
		return nil, err
	}
	if len(docs) == 0 {
		return nil, nil
	}

	var warnings []SteeringWarning

	// Check tech.md vs go.mod drift.
	if techContent, ok := docs[SteeringTech]; ok {
		techWarnings := validateTechDrift(projectPath, techContent)
		warnings = append(warnings, techWarnings...)
	}

	// Check structure.md for referenced directories that don't exist.
	if structContent, ok := docs[SteeringStructure]; ok {
		dirWarnings := validateStructureDirs(projectPath, structContent)
		warnings = append(warnings, dirWarnings...)
	}

	return warnings, nil
}

// validateTechDrift checks if dependencies mentioned in tech.md actually exist in go.mod or package.json.
func validateTechDrift(projectPath, techContent string) []SteeringWarning {
	var warnings []SteeringWarning

	// Parse go.mod dependencies.
	goModPath := filepath.Join(projectPath, "go.mod")
	goModDeps := make(map[string]bool)
	if data, err := os.ReadFile(goModPath); err == nil {
		inRequire := false
		for line := range strings.SplitSeq(string(data), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "require (" {
				inRequire = true
				continue
			}
			if trimmed == ")" {
				inRequire = false
				continue
			}
			if inRequire && trimmed != "" && !strings.HasPrefix(trimmed, "//") {
				parts := strings.Fields(trimmed)
				if len(parts) >= 1 {
					// Store the last path component as a short name.
					dep := parts[0]
					segments := strings.Split(dep, "/")
					goModDeps[segments[len(segments)-1]] = true
					goModDeps[dep] = true
				}
			}
		}
	}

	// Parse package.json dependencies.
	pkgJSONDeps := make(map[string]bool)
	pkgJSONPath := filepath.Join(projectPath, "package.json")
	if data, err := os.ReadFile(pkgJSONPath); err == nil {
		// Simple extraction: look for keys in "dependencies" or "devDependencies".
		content := string(data)
		for _, section := range []string{"dependencies", "devDependencies"} {
			idx := strings.Index(content, `"`+section+`"`)
			if idx < 0 {
				continue
			}
			braceStart := strings.Index(content[idx:], "{")
			if braceStart < 0 {
				continue
			}
			braceEnd := strings.Index(content[idx+braceStart:], "}")
			if braceEnd < 0 {
				continue
			}
			block := content[idx+braceStart : idx+braceStart+braceEnd+1]
			for bline := range strings.SplitSeq(block, "\n") {
				btrimmed := strings.TrimSpace(bline)
				if strings.HasPrefix(btrimmed, `"`) {
					name := strings.Trim(strings.SplitN(btrimmed, ":", 2)[0], `" `)
					pkgJSONDeps[name] = true
				}
			}
		}
	}

	// If no project deps found, skip drift detection.
	if len(goModDeps) == 0 && len(pkgJSONDeps) == 0 {
		return warnings
	}

	// Check each dependency line in tech.md (under "## Dependencies").
	inDeps := false
	for line := range strings.SplitSeq(techContent, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "## Dependencies") {
			inDeps = true
			continue
		}
		if strings.HasPrefix(trimmed, "## ") {
			inDeps = false
			continue
		}
		if !inDeps || !strings.HasPrefix(trimmed, "- ") {
			continue
		}
		dep := strings.TrimPrefix(trimmed, "- ")
		dep = strings.TrimSpace(dep)
		if dep == "" || strings.HasPrefix(dep, "{") {
			continue // skip placeholders
		}

		// Check against known deps.
		found := false
		depLower := strings.ToLower(dep)
		for known := range goModDeps {
			if strings.Contains(strings.ToLower(known), depLower) || strings.Contains(depLower, strings.ToLower(known)) {
				found = true
				break
			}
		}
		if !found {
			for known := range pkgJSONDeps {
				if strings.Contains(strings.ToLower(known), depLower) || strings.Contains(depLower, strings.ToLower(known)) {
					found = true
					break
				}
			}
		}
		if !found {
			warnings = append(warnings, SteeringWarning{
				File:    SteeringTech,
				Kind:    "drift",
				Message: fmt.Sprintf("dependency %q in tech.md not found in go.mod or package.json", dep),
			})
		}
	}

	return warnings
}

// validateStructureDirs checks if directories referenced in structure.md actually exist.
func validateStructureDirs(projectPath, structContent string) []SteeringWarning {
	var warnings []SteeringWarning

	// Look for directory references in the "## Directory Layout" section.
	inLayout := false
	inCodeBlock := false
	for line := range strings.SplitSeq(structContent, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "## Directory Layout") {
			inLayout = true
			continue
		}
		if strings.HasPrefix(trimmed, "## ") && inLayout {
			break
		}
		if !inLayout {
			continue
		}
		if strings.HasPrefix(trimmed, "```") {
			inCodeBlock = !inCodeBlock
			continue
		}
		if !inCodeBlock {
			continue
		}

		// Extract directory name from lines like "- internal/" or "- cmd/"
		dir := strings.TrimPrefix(trimmed, "- ")
		dir = strings.TrimSpace(dir)
		dir = strings.TrimSuffix(dir, "/")
		if dir == "" || strings.HasPrefix(dir, "{") || dir == "```" {
			continue
		}

		fullPath := filepath.Join(projectPath, dir)
		if info, err := os.Stat(fullPath); err != nil || !info.IsDir() {
			warnings = append(warnings, SteeringWarning{
				File:    SteeringStructure,
				Kind:    "missing_dir",
				Message: fmt.Sprintf("directory %q referenced in structure.md does not exist", dir),
			})
		}
	}

	return warnings
}
