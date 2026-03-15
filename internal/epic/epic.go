// Package epic manages Epic definitions under .alfred/epics/,
// grouping related spec tasks with dependencies and progress tracking.
package epic

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/hir4ta/claude-alfred/internal/spec"
)

// EpicsDir returns the .alfred/epics/ directory path.
func EpicsDir(projectPath string) string {
	return filepath.Join(projectPath, ".alfred", "epics")
}

// ActivePath returns the path to .alfred/epics/_active.yaml.
func ActivePath(projectPath string) string {
	return filepath.Join(EpicsDir(projectPath), "_active.yaml")
}

// Task status constants.
const (
	StatusDraft      = "draft"
	StatusInProgress = "in-progress"
	StatusCompleted  = "completed"
	StatusBlocked    = "blocked"
	StatusArchived   = "archived"
	StatusNotStarted = "not-started"
)

// Epic represents an epic's metadata and task list (epic.yaml).
type Epic struct {
	Name      string    `yaml:"name"`
	Status    string    `yaml:"status"`
	CreatedAt time.Time `yaml:"created_at"`
	Tasks     []Task    `yaml:"tasks,omitempty"`
}

// Task represents a task entry within an epic.
type Task struct {
	Slug      string   `yaml:"slug"`
	Status    string   `yaml:"status"`
	DependsOn []string `yaml:"depends_on,omitempty"`
}

// ActiveEpics represents the YAML content of _active.yaml.
type ActiveEpics struct {
	Primary string   `yaml:"primary,omitempty"`
	Epics   []string `yaml:"epics,omitempty"`
}

// EpicDir represents an epic's directory handle.
type EpicDir struct {
	ProjectPath string
	Slug        string
}

// Dir returns the epic's directory path.
func (e *EpicDir) Dir() string {
	return filepath.Join(EpicsDir(e.ProjectPath), e.Slug)
}

// EpicPath returns the path to epic.yaml.
func (e *EpicDir) EpicPath() string {
	return filepath.Join(e.Dir(), "epic.yaml")
}

// Exists returns true if the epic directory exists.
func (e *EpicDir) Exists() bool {
	info, err := os.Stat(e.Dir())
	return err == nil && info.IsDir()
}

// Init creates a new epic directory with an initial epic.yaml.
func Init(projectPath, slug, name string) (*EpicDir, error) {
	if !spec.ValidSlug.MatchString(slug) {
		return nil, fmt.Errorf("invalid epic_slug %q: must be lowercase alphanumeric with hyphens", slug)
	}

	ed := &EpicDir{ProjectPath: projectPath, Slug: slug}
	if ed.Exists() {
		return nil, fmt.Errorf("epic already exists: %s", slug)
	}

	if err := os.MkdirAll(ed.Dir(), 0o755); err != nil {
		return nil, fmt.Errorf("create epic dir: %w", err)
	}

	ep := &Epic{
		Name:      name,
		Status:    StatusDraft,
		CreatedAt: time.Now().UTC(),
	}
	if err := writeEpic(ed.EpicPath(), ep); err != nil {
		return nil, err
	}

	// Update _active.yaml.
	state, _ := readActiveEpics(projectPath)
	if state == nil {
		state = &ActiveEpics{}
	}
	if !slices.Contains(state.Epics, slug) {
		state.Epics = append(state.Epics, slug)
	}
	if state.Primary == "" {
		state.Primary = slug
	}
	if err := writeActiveEpics(projectPath, state); err != nil {
		return nil, err
	}

	return ed, nil
}

// Read reads the epic.yaml for this epic.
func (e *EpicDir) Read() (*Epic, error) {
	return readEpic(e.EpicPath())
}

// Save writes the epic back to epic.yaml.
func (e *EpicDir) Save(ep *Epic) error {
	return writeEpic(e.EpicPath(), ep)
}

// Link adds a task to this epic with optional dependencies.
func (e *EpicDir) Link(taskSlug string, dependsOn []string) error {
	ep, err := e.Read()
	if err != nil {
		return err
	}

	// Check for duplicate.
	for _, t := range ep.Tasks {
		if t.Slug == taskSlug {
			return fmt.Errorf("task %q already linked to epic %q", taskSlug, e.Slug)
		}
	}

	// Validate dependencies reference existing tasks in this epic.
	taskSet := make(map[string]bool, len(ep.Tasks))
	for _, t := range ep.Tasks {
		taskSet[t.Slug] = true
	}
	for _, dep := range dependsOn {
		if !taskSet[dep] {
			return fmt.Errorf("dependency %q not found in epic %q", dep, e.Slug)
		}
	}

	ep.Tasks = append(ep.Tasks, Task{
		Slug:      taskSlug,
		Status:    StatusNotStarted,
		DependsOn: dependsOn,
	})

	if ep.Status == StatusDraft {
		ep.Status = StatusInProgress
	}

	return e.Save(ep)
}

// Unlink removes a task from this epic.
// Also removes references to this task from other tasks' dependencies.
func (e *EpicDir) Unlink(taskSlug string) error {
	ep, err := e.Read()
	if err != nil {
		return err
	}

	found := false
	filtered := ep.Tasks[:0]
	for _, t := range ep.Tasks {
		if t.Slug == taskSlug {
			found = true
			continue
		}
		filtered = append(filtered, t)
	}
	if !found {
		return fmt.Errorf("task %q not linked to epic %q", taskSlug, e.Slug)
	}

	// Remove dangling dependency references.
	for i := range filtered {
		filtered[i].DependsOn = removeStr(filtered[i].DependsOn, taskSlug)
	}

	ep.Tasks = filtered
	return e.Save(ep)
}

// Progress returns (completed, total) task counts.
func (e *EpicDir) Progress() (int, int, error) {
	ep, err := e.Read()
	if err != nil {
		return 0, 0, err
	}
	completed := 0
	for _, t := range ep.Tasks {
		if t.Status == StatusCompleted {
			completed++
		}
	}
	return completed, len(ep.Tasks), nil
}

// TopologicalOrder returns task slugs in dependency-respecting order.
// Returns an error if a cycle is detected.
func TopologicalOrder(tasks []Task) ([]string, error) {
	// Build adjacency and in-degree maps.
	inDeg := make(map[string]int, len(tasks))
	adj := make(map[string][]string, len(tasks))
	for _, t := range tasks {
		if _, ok := inDeg[t.Slug]; !ok {
			inDeg[t.Slug] = 0
		}
		for _, dep := range t.DependsOn {
			adj[dep] = append(adj[dep], t.Slug)
			inDeg[t.Slug]++
		}
	}

	// Kahn's algorithm.
	var queue []string
	for _, t := range tasks {
		if inDeg[t.Slug] == 0 {
			queue = append(queue, t.Slug)
		}
	}
	// Stable sort for deterministic output.
	sort.Strings(queue)

	var order []string
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		order = append(order, cur)

		neighbors := adj[cur]
		sort.Strings(neighbors)
		for _, next := range neighbors {
			inDeg[next]--
			if inDeg[next] == 0 {
				queue = append(queue, next)
			}
		}
	}

	if len(order) != len(tasks) {
		return nil, fmt.Errorf("dependency cycle detected")
	}
	return order, nil
}

// NextActionable returns task slugs that are not started and have all dependencies completed.
func NextActionable(tasks []Task) []string {
	statusMap := make(map[string]string, len(tasks))
	for _, t := range tasks {
		statusMap[t.Slug] = t.Status
	}

	var actionable []string
	for _, t := range tasks {
		if t.Status != StatusNotStarted {
			continue
		}
		allDepsCompleted := true
		for _, dep := range t.DependsOn {
			if statusMap[dep] != StatusCompleted {
				allDepsCompleted = false
				break
			}
		}
		if allDepsCompleted {
			actionable = append(actionable, t.Slug)
		}
	}
	return actionable
}

// Summary holds a snapshot of epic state for display.
type Summary struct {
	Slug      string
	Name      string
	Status    string
	Completed int
	Total     int
	Tasks     []Task
}

// ListAll returns summaries for all epics in the project.
func ListAll(projectPath string) []Summary {
	dir := EpicsDir(projectPath)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var summaries []Summary
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), "_") || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		ed := &EpicDir{ProjectPath: projectPath, Slug: entry.Name()}
		ep, err := ed.Read()
		if err != nil {
			continue
		}
		completed := 0
		for _, t := range ep.Tasks {
			if t.Status == StatusCompleted {
				completed++
			}
		}
		summaries = append(summaries, Summary{
			Slug:      entry.Name(),
			Name:      ep.Name,
			Status:    ep.Status,
			Completed: completed,
			Total:     len(ep.Tasks),
			Tasks:     ep.Tasks,
		})
	}
	return summaries
}

// Remove deletes an epic directory and removes it from _active.yaml.
// Tasks (specs) under this epic are NOT deleted — they become standalone.
func Remove(projectPath, slug string) error {
	ed := &EpicDir{ProjectPath: projectPath, Slug: slug}
	if !ed.Exists() {
		return fmt.Errorf("epic %q not found", slug)
	}
	if err := os.RemoveAll(ed.Dir()); err != nil {
		return fmt.Errorf("remove epic dir: %w", err)
	}

	state, _ := readActiveEpics(projectPath)
	if state == nil {
		return nil
	}
	state.Epics = removeStr(state.Epics, slug)
	if state.Primary == slug {
		if len(state.Epics) > 0 {
			state.Primary = state.Epics[0]
		} else {
			state.Primary = ""
		}
	}
	return writeActiveEpics(projectPath, state)
}

// UnlinkTaskFromAllEpics removes a task slug from all epics in the project.
// Called during spec deletion to clean up dangling references.
func UnlinkTaskFromAllEpics(projectPath, taskSlug string) {
	for _, s := range ListAll(projectPath) {
		ed := &EpicDir{ProjectPath: projectPath, Slug: s.Slug}
		hasTask := false
		for _, t := range s.Tasks {
			if t.Slug == taskSlug {
				hasTask = true
				break
			}
		}
		if hasTask {
			_ = ed.Unlink(taskSlug) // best-effort cleanup
		}
	}
}

// SyncTaskStatus updates a task's status within its parent epic.
// Returns true if the status was actually changed.
func SyncTaskStatus(projectPath, taskSlug, newStatus string) bool {
	for _, s := range ListAll(projectPath) {
		for _, t := range s.Tasks {
			if t.Slug != taskSlug {
				continue
			}
			if t.Status == newStatus {
				return false
			}
			ed := &EpicDir{ProjectPath: projectPath, Slug: s.Slug}
			ep, err := ed.Read()
			if err != nil {
				return false
			}
			for i := range ep.Tasks {
				if ep.Tasks[i].Slug == taskSlug {
					ep.Tasks[i].Status = newStatus
					break
				}
			}
			// Auto-update epic status.
			allCompleted := len(ep.Tasks) > 0
			anyInProgress := false
			for _, tk := range ep.Tasks {
				if tk.Status != StatusCompleted {
					allCompleted = false
				}
				if tk.Status == StatusInProgress {
					anyInProgress = true
				}
			}
			if allCompleted {
				ep.Status = StatusCompleted
			} else if anyInProgress {
				ep.Status = StatusInProgress
			}
			_ = ed.Save(ep)
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

func readEpic(path string) (*Epic, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read epic.yaml: %w", err)
	}
	var ep Epic
	if err := yaml.Unmarshal(data, &ep); err != nil {
		return nil, fmt.Errorf("parse epic.yaml: %w", err)
	}
	return &ep, nil
}

func writeEpic(path string, ep *Epic) error {
	data, err := yaml.Marshal(ep)
	if err != nil {
		return fmt.Errorf("marshal epic.yaml: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("write epic.yaml: %w", err)
	}
	return os.Rename(tmp, path)
}

func readActiveEpics(projectPath string) (*ActiveEpics, error) {
	data, err := os.ReadFile(ActivePath(projectPath))
	if err != nil {
		return nil, err
	}
	var state ActiveEpics
	if err := yaml.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

func writeActiveEpics(projectPath string, state *ActiveEpics) error {
	if err := os.MkdirAll(EpicsDir(projectPath), 0o755); err != nil {
		return fmt.Errorf("create epics dir: %w", err)
	}
	data, err := yaml.Marshal(state)
	if err != nil {
		return fmt.Errorf("marshal _active.yaml: %w", err)
	}
	path := ActivePath(projectPath)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("write _active.yaml: %w", err)
	}
	return os.Rename(tmp, path)
}

func removeStr(ss []string, s string) []string {
	filtered := ss[:0]
	for _, v := range ss {
		if v != s {
			filtered = append(filtered, v)
		}
	}
	return filtered
}
