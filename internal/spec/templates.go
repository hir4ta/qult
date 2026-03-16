package spec

import (
	"embed"
	"fmt"
	"strings"
	"text/template"
)

//go:embed templates/*.tmpl
var templateFS embed.FS

// TemplateData holds substitution values for spec templates.
type TemplateData struct {
	TaskSlug    string
	Description string
	Date        string // YYYY-MM-DD
}

// RenderTemplate renders a single spec file template.
func RenderTemplate(f SpecFile, data TemplateData) (string, error) {
	name := string(f) + ".tmpl"
	raw, err := templateFS.ReadFile("templates/" + name)
	if err != nil {
		return "", fmt.Errorf("read template %s: %w", name, err)
	}

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

// RenderAll renders all spec file templates, returning a map keyed by SpecFile.
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
