package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/spec"
)

// runSteeringInit analyzes the project and generates steering docs.
func runSteeringInit() error {
	projectPath, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	force := false
	for _, arg := range os.Args[2:] {
		if arg == "--force" || arg == "-f" {
			force = true
		}
	}

	data, err := analyzeProject(projectPath)
	if err != nil {
		return fmt.Errorf("analyze project: %w", err)
	}

	rendered, err := spec.RenderSteering(*data, projectPath)
	if err != nil {
		return fmt.Errorf("render steering templates: %w", err)
	}

	if err := spec.WriteSteering(projectPath, rendered, force); err != nil {
		return err
	}

	fmt.Printf("Created steering docs in %s\n", spec.SteeringDir(projectPath))
	for _, f := range spec.AllSteeringFiles {
		fmt.Printf("  - %s\n", f)
	}
	return nil
}

// analyzeProject reads project files and returns SteeringData.
func analyzeProject(projectPath string) (*spec.SteeringData, error) {
	data := &spec.SteeringData{
		ProjectName: filepath.Base(projectPath),
		Date:        time.Now().UTC().Format("2006-01-02"),
	}

	// Try go.mod.
	goModPath := filepath.Join(projectPath, "go.mod")
	if module, deps, err := parseGoMod(goModPath); err == nil {
		if module != "" {
			// Use last path segment as project name.
			parts := strings.Split(module, "/")
			data.ProjectName = parts[len(parts)-1]
		}
		data.Dependencies = deps
		// Detect Go version from go.mod.
		data.TechStack = detectGoVersion(goModPath)
	}

	// Try package.json.
	pkgJSONPath := filepath.Join(projectPath, "package.json")
	if name, deps, err := parsePackageJSON(pkgJSONPath); err == nil {
		if name != "" && data.ProjectName == filepath.Base(projectPath) {
			data.ProjectName = name
		}
		data.Dependencies = append(data.Dependencies, deps...)
		if data.TechStack == "" {
			data.TechStack = "Node.js"
		}
	}

	// Try README.md for description.
	readmePath := filepath.Join(projectPath, "README.md")
	if desc := extractREADMEDescription(readmePath); desc != "" {
		data.Description = desc
	}

	// Scan top-level directories.
	if dirs, err := scanTopDirs(projectPath); err == nil {
		data.Packages = dirs
	}

	// Try CLAUDE.md for conventions.
	claudeMDPath := filepath.Join(projectPath, "CLAUDE.md")
	if conventions, err := extractCLAUDEMDConventions(claudeMDPath); err == nil {
		data.Conventions = conventions
	}

	return data, nil
}

// parseGoMod extracts module name and dependencies from go.mod.
func parseGoMod(path string) (module string, deps []string, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}

	inRequire := false
	for line := range strings.SplitSeq(string(data), "\n") {
		trimmed := strings.TrimSpace(line)

		// Module line.
		if strings.HasPrefix(trimmed, "module ") {
			module = strings.TrimPrefix(trimmed, "module ")
			module = strings.TrimSpace(module)
			continue
		}

		// Require block.
		if trimmed == "require (" {
			inRequire = true
			continue
		}
		if trimmed == ")" {
			inRequire = false
			continue
		}

		// Single-line require.
		if strings.HasPrefix(trimmed, "require ") && !strings.Contains(trimmed, "(") {
			parts := strings.Fields(trimmed)
			if len(parts) >= 2 {
				deps = append(deps, parts[1])
			}
			continue
		}

		if inRequire && trimmed != "" && !strings.HasPrefix(trimmed, "//") {
			parts := strings.Fields(trimmed)
			if len(parts) >= 1 {
				deps = append(deps, parts[0])
			}
		}
	}

	return module, deps, nil
}

// detectGoVersion extracts the Go version from go.mod.
func detectGoVersion(goModPath string) string {
	data, err := os.ReadFile(goModPath)
	if err != nil {
		return "Go"
	}
	for line := range strings.SplitSeq(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "go ") {
			ver := strings.TrimPrefix(trimmed, "go ")
			return "Go " + strings.TrimSpace(ver)
		}
	}
	return "Go"
}

// parsePackageJSON extracts name and dependencies from package.json.
func parsePackageJSON(path string) (name string, deps []string, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}

	content := string(data)

	// Extract name (simple string extraction, no JSON parser needed).
	if idx := strings.Index(content, `"name"`); idx >= 0 {
		rest := content[idx:]
		colonIdx := strings.Index(rest, ":")
		if colonIdx >= 0 {
			afterColon := strings.TrimSpace(rest[colonIdx+1:])
			if strings.HasPrefix(afterColon, `"`) {
				endQuote := strings.Index(afterColon[1:], `"`)
				if endQuote >= 0 {
					name = afterColon[1 : endQuote+1]
				}
			}
		}
	}

	// Extract dependencies.
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
				depName := strings.Trim(strings.SplitN(btrimmed, ":", 2)[0], `" `)
				if depName != "" {
					deps = append(deps, depName)
				}
			}
		}
	}

	return name, deps, nil
}

// scanTopDirs returns top-level directory names for structure analysis.
func scanTopDirs(projectPath string) ([]string, error) {
	entries, err := os.ReadDir(projectPath)
	if err != nil {
		return nil, err
	}

	var dirs []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		// Skip hidden and common non-source directories.
		if strings.HasPrefix(name, ".") || name == "node_modules" || name == "vendor" || name == "dist" || name == "build" {
			continue
		}
		dirs = append(dirs, name+"/")
	}
	return dirs, nil
}

// extractCLAUDEMDConventions extracts conventions/rules from CLAUDE.md.
func extractCLAUDEMDConventions(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var conventions []string
	inRules := false
	for line := range strings.SplitSeq(string(data), "\n") {
		trimmed := strings.TrimSpace(line)

		// Look for sections containing rules/conventions.
		if strings.HasPrefix(trimmed, "## ") || strings.HasPrefix(trimmed, "### ") {
			lower := strings.ToLower(trimmed)
			inRules = strings.Contains(lower, "rule") ||
				strings.Contains(lower, "convention") ||
				strings.Contains(lower, "style") ||
				strings.Contains(lower, "naming")
			continue
		}

		if inRules && strings.HasPrefix(trimmed, "- ") {
			convention := strings.TrimPrefix(trimmed, "- ")
			convention = strings.TrimSpace(convention)
			if convention != "" && len(convention) < 200 {
				conventions = append(conventions, convention)
			}
		}
	}

	// Cap at 20 conventions to keep it manageable.
	if len(conventions) > 20 {
		conventions = conventions[:20]
	}

	return conventions, nil
}

// extractREADMEDescription extracts the project description from README.md.
// Returns the first non-empty, non-heading paragraph.
func extractREADMEDescription(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}

	var desc strings.Builder
	pastFirstHeading := false
	for line := range strings.SplitSeq(string(data), "\n") {
		trimmed := strings.TrimSpace(line)

		if strings.HasPrefix(trimmed, "# ") {
			if pastFirstHeading {
				break // stop at second heading
			}
			pastFirstHeading = true
			continue
		}

		if !pastFirstHeading {
			continue
		}

		// Skip badges, images, empty lines at start.
		if trimmed == "" && desc.Len() == 0 {
			continue
		}
		if strings.HasPrefix(trimmed, "![") || strings.HasPrefix(trimmed, "[![") {
			continue
		}

		if trimmed == "" && desc.Len() > 0 {
			break // end at first blank line after content
		}

		if desc.Len() > 0 {
			desc.WriteByte(' ')
		}
		desc.WriteString(trimmed)
	}

	result := desc.String()
	// Truncate if too long.
	runes := []rune(result)
	if len(runes) > 500 {
		result = string(runes[:500]) + "..."
	}
	return result
}
