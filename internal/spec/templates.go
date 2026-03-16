package spec

import (
	"embed"
	"fmt"
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

// templatePath returns the embed.FS path for a spec file template.
// Bugfix.md uses templates/bugfix/bugfix.md.tmpl; all others use templates/<file>.tmpl.
func templatePath(f SpecFile, specType SpecType) string {
	if f == FileBugfix {
		return "templates/bugfix/bugfix.md.tmpl"
	}
	return "templates/" + string(f) + ".tmpl"
}

// RenderTemplate renders a single spec file template.
func RenderTemplate(f SpecFile, data TemplateData) (string, error) {
	return renderTemplate(f, TypeFeature, data)
}

// renderTemplate renders a template for a specific file and spec type.
func renderTemplate(f SpecFile, specType SpecType, data TemplateData) (string, error) {
	path := templatePath(f, specType)
	raw, err := templateFS.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read template %s: %w", path, err)
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
func RenderForSize(size SpecSize, specType SpecType, data TemplateData) (map[SpecFile]string, error) {
	files := FilesForSize(size, specType)
	result := make(map[SpecFile]string, len(files))
	for _, f := range files {
		content, err := renderTemplate(f, specType, data)
		if err != nil {
			return nil, err
		}
		result[f] = content
	}
	return result, nil
}
