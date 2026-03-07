// Package spec manages Butler Protocol spec files under .alfred/specs/,
// providing task lifecycle (init, switch, delete) and DB synchronization.
package spec

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// validSlug matches URL-safe task identifiers: lowercase letters, digits, hyphens.
var validSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9\-]{0,63}$`)

// SpecFile represents a spec file type.
type SpecFile string

const (
	FileRequirements SpecFile = "requirements.md"
	FileDesign       SpecFile = "design.md"
	FileDecisions    SpecFile = "decisions.md"
	FileSession      SpecFile = "session.md"
)

// AllFiles lists all spec file types.
var AllFiles = []SpecFile{
	FileRequirements,
	FileDesign,
	FileDecisions,
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

// ActiveTask represents a task entry in _active.md.
type ActiveTask struct {
	Slug      string `yaml:"slug"`
	StartedAt string `yaml:"started_at"`
}

// ActiveState represents the YAML content of _active.md.
type ActiveState struct {
	Primary string       `yaml:"primary"`
	Tasks   []ActiveTask `yaml:"tasks"`
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
		return nil, fmt.Errorf("spec already exists for '%s'; use spec-update to modify", taskSlug)
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

		FileDecisions: fmt.Sprintf(`# Decisions: %s

<!-- Format:
## [YYYY-MM-DD] Decision Title
- **Chosen:** option
- **Alternatives:** A, B
- **Reason:** why
-->
`, taskSlug),

		FileSession: fmt.Sprintf(`# Session: %s

## Status
active

## Currently Working On
Task just initialized.

## Recent Decisions (last 3)


## Next Steps
1.

## Blockers
None

## Modified Files (this session)

`, taskSlug),
	}

	for f, content := range templates {
		if err := os.WriteFile(sd.FilePath(f), []byte(content), 0o644); err != nil {
			return nil, fmt.Errorf("write %s: %w", f, err)
		}
	}

	// Write or update _active.md
	now := time.Now().UTC().Format(time.RFC3339)
	state, _ := readActiveState(projectPath) // ignore error — file may not exist
	if state == nil {
		state = &ActiveState{}
	}
	state.Primary = taskSlug
	// Avoid duplicate entries if slug already exists in tasks list (e.g., spec dir was manually deleted).
	alreadyListed := false
	for _, t := range state.Tasks {
		if t.Slug == taskSlug {
			alreadyListed = true
			break
		}
	}
	if !alreadyListed {
		state.Tasks = append(state.Tasks, ActiveTask{Slug: taskSlug, StartedAt: now})
	}
	if err := writeActiveState(projectPath, state); err != nil {
		return nil, err
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

// WriteFile writes content to a spec file using atomic rename to prevent
// partial writes from concurrent hook invocations.
func (s *SpecDir) WriteFile(f SpecFile, content string) error {
	path := s.FilePath(f)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
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

// ReadActive reads the primary task slug from _active.md.
// Supports both legacy format ("task: slug") and new YAML format.
func ReadActive(projectPath string) (string, error) {
	state, err := readActiveState(projectPath)
	if err != nil {
		return "", err
	}
	if state.Primary == "" {
		return "", fmt.Errorf("no primary task in _active.md")
	}
	return state.Primary, nil
}

// ReadActiveState reads the full active state from _active.md.
func ReadActiveState(projectPath string) (*ActiveState, error) {
	return readActiveState(projectPath)
}

// readActiveState reads and parses _active.md, supporting both legacy and YAML formats.
func readActiveState(projectPath string) (*ActiveState, error) {
	data, err := os.ReadFile(ActivePath(projectPath))
	if err != nil {
		return nil, fmt.Errorf("read _active.md: %w", err)
	}

	// Try YAML first
	var state ActiveState
	if err := yaml.Unmarshal(data, &state); err == nil && state.Primary != "" {
		return &state, nil
	}

	// Legacy format: "task: slug\nstarted_at: time"
	var slug, startedAt string
	for line := range strings.SplitSeq(string(data), "\n") {
		if s, ok := strings.CutPrefix(line, "task: "); ok {
			slug = s
		}
		if s, ok := strings.CutPrefix(line, "started_at: "); ok {
			startedAt = s
		}
	}
	if slug == "" {
		return nil, fmt.Errorf("no task field in _active.md")
	}
	return &ActiveState{
		Primary: slug,
		Tasks:   []ActiveTask{{Slug: slug, StartedAt: startedAt}},
	}, nil
}

// writeActiveState writes the active state as YAML to _active.md.
func writeActiveState(projectPath string, state *ActiveState) error {
	if err := os.MkdirAll(SpecsDir(projectPath), 0o755); err != nil {
		return fmt.Errorf("create specs dir: %w", err)
	}
	data, err := yaml.Marshal(state)
	if err != nil {
		return fmt.Errorf("marshal _active.md: %w", err)
	}
	if err := os.WriteFile(ActivePath(projectPath), data, 0o644); err != nil {
		return fmt.Errorf("write _active.md: %w", err)
	}
	return nil
}

// SwitchActive changes the primary task to the given slug.
func SwitchActive(projectPath, taskSlug string) error {
	state, err := readActiveState(projectPath)
	if err != nil {
		return err
	}
	found := false
	for _, t := range state.Tasks {
		if t.Slug == taskSlug {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("task %q not found in _active.md", taskSlug)
	}
	state.Primary = taskSlug
	return writeActiveState(projectPath, state)
}

// RemoveTask removes a task from _active.md and its spec directory.
// If the removed task was primary, the next task becomes primary.
// Returns true if _active.md was also removed (no tasks left).
func RemoveTask(projectPath, taskSlug string) (bool, error) {
	state, err := readActiveState(projectPath)
	if err != nil {
		return false, err
	}

	filtered := state.Tasks[:0]
	for _, t := range state.Tasks {
		if t.Slug != taskSlug {
			filtered = append(filtered, t)
		}
	}
	if len(filtered) == len(state.Tasks) {
		return false, fmt.Errorf("task %q not found in _active.md", taskSlug)
	}

	// Remove spec directory
	sd := &SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if sd.Exists() {
		if err := os.RemoveAll(sd.Dir()); err != nil {
			return false, fmt.Errorf("remove spec dir: %w", err)
		}
	}

	if len(filtered) == 0 {
		// No tasks left — remove _active.md
		os.Remove(ActivePath(projectPath))
		return true, nil
	}

	state.Tasks = filtered
	if state.Primary == taskSlug {
		state.Primary = filtered[0].Slug
	}
	return false, writeActiveState(projectPath, state)
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
