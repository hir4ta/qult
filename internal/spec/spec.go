// Package spec manages Alfred Protocol spec files under .alfred/specs/,
// providing task lifecycle (init, switch, delete) and DB synchronization.
package spec

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"gopkg.in/yaml.v3"
)

// DebugLog is an optional callback for diagnostic messages from the spec layer.
// Set by the application (e.g., cmd/alfred) to route spec debug output to its
// own logging facility. Nil by default (no logging).
var DebugLog func(format string, args ...any)

// ValidSlug matches URL-safe task identifiers: lowercase letters, digits, hyphens.
var ValidSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9\-]{0,63}$`)

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
	if !ValidSlug.MatchString(taskSlug) {
		return nil, fmt.Errorf("invalid task_slug %q: must be lowercase alphanumeric with hyphens (e.g., 'add-auth')", taskSlug)
	}

	sd := &SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}

	// Refuse to overwrite an existing spec directory.
	if sd.Exists() {
		return nil, fmt.Errorf("spec already exists for '%s'; use spec action=update to modify", taskSlug)
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

// lockSpecDir acquires an advisory flock on a .lock file in the spec directory.
// Returns the lock file handle (caller must defer unlock+close) or an error.
// Uses non-blocking lock with exponential backoff (100/200/400/800ms, 1.5s total)
// to handle concurrent hook invocations (e.g., PreCompact + SessionEnd overlap).
// Respects context cancellation to avoid wasting budget on tight timeouts.
// Note: 1.5s worst-case consumes ~60% of SessionEnd's 2.5s budget; callers
// fall back to unprotected write if the lock times out.
func (s *SpecDir) lockSpecDir(ctx context.Context) (*os.File, error) {
	lockPath := filepath.Join(s.Dir(), ".lock")
	lf, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	// Exponential backoff: short contention resolves faster, total ~1.5s.
	delays := [4]time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond, 800 * time.Millisecond}
	for attempt, delay := range delays {
		err = syscall.Flock(int(lf.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return lf, nil
		}
		if ctx.Err() != nil {
			break
		}
		if attempt < len(delays)-1 {
			select {
			case <-ctx.Done():
				lf.Close()
				return nil, fmt.Errorf("spec lock cancelled: %w", ctx.Err())
			case <-time.After(delay):
			}
		}
	}
	lf.Close()
	return nil, fmt.Errorf("spec lock timeout on %s", lockPath)
}

// unlockSpecDir releases the advisory lock and closes the file.
func unlockSpecDir(lf *os.File) {
	if lf == nil {
		return
	}
	_ = syscall.Flock(int(lf.Fd()), syscall.LOCK_UN)
	lf.Close()
}

// WriteFile writes content to a spec file using atomic rename to prevent
// partial writes from concurrent hook invocations. Protected by advisory flock.
// Pass context to respect cancellation during lock acquisition.
func (s *SpecDir) WriteFile(ctx context.Context, f SpecFile, content string) error {
	lf, err := s.lockSpecDir(ctx)
	if err != nil {
		// Fall back to unprotected write if lock fails (concurrent access risk accepted).
		if DebugLog != nil {
			DebugLog("spec: lock timeout for %s/%s, falling back to unprotected write: %v", s.TaskSlug, f, err)
		}
		fmt.Fprintf(os.Stderr, "[alfred] warning: spec lock contention on %s — concurrent write possible\n", f)
		return s.writeFileUnlocked(f, content)
	}
	defer unlockSpecDir(lf)
	return s.writeFileUnlocked(f, content)
}

// writeFileUnlocked performs the actual atomic write (tmp + rename).
// Saves a history snapshot before overwriting (fail-open).
func (s *SpecDir) writeFileUnlocked(f SpecFile, content string) error {
	// Save history before overwriting (fail-open: errors don't prevent the write).
	_ = s.saveHistory(f)
	return s.writeFileRaw(f, content)
}

// writeFileRaw performs atomic write (tmp + rename) without saving history.
func (s *SpecDir) writeFileRaw(f SpecFile, content string) error {
	path := s.FilePath(f)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// AppendFile appends content to a spec file via read-append-rename.
// Protected by advisory flock to prevent lost updates from concurrent callers.
func (s *SpecDir) AppendFile(ctx context.Context, f SpecFile, content string) error {
	lf, err := s.lockSpecDir(ctx)
	if err != nil {
		// Fall back to unprotected append if lock fails (concurrent access risk accepted).
		if DebugLog != nil {
			DebugLog("spec: lock timeout for %s/%s, falling back to unprotected append: %v", s.TaskSlug, f, err)
		}
		fmt.Fprintf(os.Stderr, "[alfred] warning: spec lock contention on %s — concurrent write possible\n", f)
		return s.appendFileUnlocked(f, content)
	}
	defer unlockSpecDir(lf)
	return s.appendFileUnlocked(f, content)
}

// appendFileUnlocked performs the actual read-append-rename.
func (s *SpecDir) appendFileUnlocked(f SpecFile, content string) error {
	path := s.FilePath(f)
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return s.writeFileUnlocked(f, string(existing)+content)
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
