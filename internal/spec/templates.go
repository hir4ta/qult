package spec

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/template"
)

//go:embed templates/*.tmpl templates/bugfix/*.tmpl
var templateFS embed.FS

// TemplateData holds substitution values for spec templates.
type TemplateData struct {
	TaskSlug    string
	Description string
	Date        string // YYYY-MM-DD
	SpecType    string // "feature" or "bugfix"
}

// TemplatesDir returns the .alfred/templates/specs/ directory path.
func TemplatesDir(projectPath string) string {
	return filepath.Join(projectPath, ".alfred", "templates", "specs")
}

// templatePath returns the embed.FS path for a spec file template.
// Bugfix.md uses templates/bugfix/bugfix.md.tmpl; all others use templates/<file>.tmpl.
func templatePath(f SpecFile, specType SpecType) string {
	if f == FileBugfix {
		return "templates/bugfix/bugfix.md.tmpl"
	}
	return "templates/" + string(f) + ".tmpl"
}

// readTemplateRaw reads a template file, checking the project's .alfred/templates/specs/
// directory first, then falling back to the embedded default.
// If projectPath is empty, only the embedded default is used.
func readTemplateRaw(f SpecFile, specType SpecType, projectPath string) ([]byte, error) {
	if projectPath != "" {
		// User override: .alfred/templates/specs/<filename>.tmpl
		userPath := filepath.Join(TemplatesDir(projectPath), string(f)+".tmpl")
		if f == FileBugfix {
			userPath = filepath.Join(TemplatesDir(projectPath), "bugfix", "bugfix.md.tmpl")
		}
		if raw, err := os.ReadFile(userPath); err == nil {
			return raw, nil
		}
	}

	// Fallback: embedded default.
	path := templatePath(f, specType)
	raw, err := templateFS.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read template %s: %w", path, err)
	}
	return raw, nil
}

// RenderTemplate renders a single spec file template using embedded defaults.
func RenderTemplate(f SpecFile, data TemplateData) (string, error) {
	return renderTemplateWithProject(f, TypeFeature, data, "")
}

// renderTemplate renders a template for a specific file and spec type using embedded defaults.
func renderTemplate(f SpecFile, specType SpecType, data TemplateData) (string, error) {
	return renderTemplateWithProject(f, specType, data, "")
}

// renderTemplateWithProject renders a template with 2-layer resolution (user override > embedded default).
func renderTemplateWithProject(f SpecFile, specType SpecType, data TemplateData, projectPath string) (string, error) {
	raw, err := readTemplateRaw(f, specType, projectPath)
	if err != nil {
		return "", err
	}

	name := string(f) + ".tmpl"
	tmpl, err := template.New(name).Parse(string(raw))
	if err != nil {
		return "", fmt.Errorf("parse template %s: %w", name, err)
	}

	var buf strings.Builder
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("execute template %s: %w", name, err)
	}
	return buf.String(), nil
}

// RenderAll renders all 7 feature spec file templates, returning a map keyed by SpecFile.
func RenderAll(data TemplateData) (map[SpecFile]string, error) {
	result := make(map[SpecFile]string, len(AllFiles))
	for _, f := range AllFiles {
		content, err := RenderTemplate(f, data)
		if err != nil {
			return nil, err
		}
		result[f] = content
	}
	return result, nil
}

// RenderForSize renders only the templates appropriate for the given size and type.
// projectPath enables 2-layer template resolution (user override > embedded default).
func RenderForSize(size SpecSize, specType SpecType, data TemplateData, projectPath string) (map[SpecFile]string, error) {
	files := FilesForSize(size, specType)
	result := make(map[SpecFile]string, len(files))
	for _, f := range files {
		content, err := renderTemplateWithProject(f, specType, data, projectPath)
		if err != nil {
			return nil, err
		}
		result[f] = content
	}
	return result, nil
}
