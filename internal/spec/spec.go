package spec

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// validSlug matches URL-safe task identifiers: lowercase letters, digits, hyphens.
var validSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9\-]{0,63}$`)

// SpecFile represents a spec file type.
type SpecFile string

const (
	FileRequirements SpecFile = "requirements.md"
	FileDesign       SpecFile = "design.md"
	FileTasks        SpecFile = "tasks.md"
	FileDecisions    SpecFile = "decisions.md"
	FileKnowledge    SpecFile = "knowledge.md"
	FileSession      SpecFile = "session.md"
)

// AllFiles lists all spec file types.
var AllFiles = []SpecFile{
	FileRequirements,
	FileDesign,
	FileTasks,
	FileDecisions,
	FileKnowledge,
	FileSession,
}

// SpecDir represents a task's spec directory.
type SpecDir struct {
	ProjectPath string
	TaskSlug    string
}

// Section represents a spec file's content with metadata.
type Section struct {
	File    SpecFile
	Content string
	URL     string
}

// RootDir returns the .alfred/ directory path.
func RootDir(projectPath string) string {
	return filepath.Join(projectPath, ".alfred")
}

// SpecsDir returns the .alfred/specs/ directory path.
func SpecsDir(projectPath string) string {
	return filepath.Join(projectPath, ".alfred", "specs")
}

// ActivePath returns the path to .alfred/specs/_active.md.
func ActivePath(projectPath string) string {
	return filepath.Join(projectPath, ".alfred", "specs", "_active.md")
}

// Dir returns the task's spec directory path.
func (s *SpecDir) Dir() string {
	return filepath.Join(SpecsDir(s.ProjectPath), s.TaskSlug)
}

// FilePath returns the full path to a spec file.
func (s *SpecDir) FilePath(f SpecFile) string {
	return filepath.Join(s.Dir(), string(f))
}

// Exists returns true if the spec directory exists.
func (s *SpecDir) Exists() bool {
	info, err := os.Stat(s.Dir())
	return err == nil && info.IsDir()
}

// Init creates a new spec directory with template files and sets _active.md.
func Init(projectPath, taskSlug, description string) (*SpecDir, error) {
	if !validSlug.MatchString(taskSlug) {
		return nil, fmt.Errorf("invalid task_slug %q: must be lowercase alphanumeric with hyphens (e.g., 'add-auth')", taskSlug)
	}

	sd := &SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}

	// Refuse to overwrite an existing spec directory.
	if sd.Exists() {
		return nil, fmt.Errorf("spec already exists for '%s'; use butler-update to modify", taskSlug)
	}

	if err := os.MkdirAll(sd.Dir(), 0o755); err != nil {
		return nil, fmt.Errorf("create spec dir: %w", err)
	}

	templates := map[SpecFile]string{
		FileRequirements: fmt.Sprintf(`# Requirements: %s

## Goal

%s

## Success Criteria

- [ ]

## Out of Scope

-
`, taskSlug, description),

		FileDesign: fmt.Sprintf(`# Design: %s

## Architecture



## Tech Decisions


`, taskSlug),

		FileTasks: fmt.Sprintf(`# Tasks: %s

- [ ]
`, taskSlug),

		FileDecisions: fmt.Sprintf(`# Decisions: %s

<!-- Format:
## [YYYY-MM-DD] Decision Title
- **Chosen:** option
- **Alternatives:** A, B
- **Reason:** why
-->
`, taskSlug),

		FileKnowledge: fmt.Sprintf(`# Knowledge: %s

<!-- Format:
## Discovery Title
- **Finding:** what
- **Context:** when/where
- **Dead ends:** what didn't work and why
-->
`, taskSlug),

		FileSession: fmt.Sprintf(`# Session: %s

## Status
active

## Current Position
Task just initialized.

## What I Was Doing



## Next Steps

- [ ]

## Key Context for Resumption



## Modified Files



## Unresolved Issues


`, taskSlug),
	}

	for f, content := range templates {
		if err := os.WriteFile(sd.FilePath(f), []byte(content), 0o644); err != nil {
			return nil, fmt.Errorf("write %s: %w", f, err)
		}
	}

	// Write _active.md
	active := fmt.Sprintf("task: %s\nstarted_at: %s\n", taskSlug, time.Now().UTC().Format(time.RFC3339))
	if err := os.WriteFile(ActivePath(projectPath), []byte(active), 0o644); err != nil {
		return nil, fmt.Errorf("write _active.md: %w", err)
	}

	return sd, nil
}

// ReadFile reads the content of a spec file.
func (s *SpecDir) ReadFile(f SpecFile) (string, error) {
	data, err := os.ReadFile(s.FilePath(f))
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// WriteFile writes content to a spec file.
func (s *SpecDir) WriteFile(f SpecFile, content string) error {
	return os.WriteFile(s.FilePath(f), []byte(content), 0o644)
}

// AppendFile appends content to a spec file.
func (s *SpecDir) AppendFile(f SpecFile, content string) error {
	f2, err := os.OpenFile(s.FilePath(f), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f2.Close()
	_, err = f2.WriteString(content)
	return err
}

// ReadActive reads the task slug from _active.md.
func ReadActive(projectPath string) (string, error) {
	data, err := os.ReadFile(ActivePath(projectPath))
	if err != nil {
		return "", fmt.Errorf("read _active.md: %w", err)
	}
	for line := range strings.SplitSeq(string(data), "\n") {
		if slug, ok := strings.CutPrefix(line, "task: "); ok {
			return slug, nil
		}
	}
	return "", fmt.Errorf("no task field in _active.md")
}

// AllSections returns all spec files as Sections with content and URL.
func (s *SpecDir) AllSections() ([]Section, error) {
	projectBase := filepath.Base(s.ProjectPath)
	var sections []Section
	for _, f := range AllFiles {
		content, err := s.ReadFile(f)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", f, err)
		}
		url := fmt.Sprintf("spec://%s/%s/%s", projectBase, s.TaskSlug, string(f))
		sections = append(sections, Section{
			File:    f,
			Content: content,
			URL:     url,
		})
	}
	return sections, nil
}
