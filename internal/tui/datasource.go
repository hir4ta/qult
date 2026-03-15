package tui

import (
	"context"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/epic"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// EpicSummary holds display data for an epic.
type EpicSummary struct {
	Slug      string
	Name      string
	Status    string
	Completed int
	Total     int
	Tasks     []TaskSummary
}

// TaskSummary holds display data for a task.
type TaskSummary struct {
	Slug      string
	EpicSlug  string // empty = standalone
	Status    string
	DependsOn []string
	UpdatedAt time.Time
}

// SpecEntry holds display data for a spec file.
type SpecEntry struct {
	TaskSlug  string
	File      string
	Size      int64
	UpdatedAt time.Time
}

// MemoryEntry holds display data for a memory record.
type MemoryEntry struct {
	Label   string
	Project string
	Content string
	Age     time.Duration
}

// DataSource abstracts data retrieval for the TUI.
type DataSource interface {
	Epics() []EpicSummary
	Tasks() []TaskSummary
	Specs() []SpecEntry
	SpecContent(taskSlug, file string) string
	Memories(limit int) []MemoryEntry
	SearchMemories(query string) []MemoryEntry
}

// fileDataSource implements DataSource by reading .alfred/ files and SQLite.
type fileDataSource struct {
	projectPath string
	st          *store.Store
}

// NewFileDataSource creates a DataSource backed by filesystem + SQLite.
func NewFileDataSource(projectPath string, st *store.Store) DataSource {
	return &fileDataSource{projectPath: projectPath, st: st}
}

func (ds *fileDataSource) Epics() []EpicSummary {
	raw := epic.ListAll(ds.projectPath)
	summaries := make([]EpicSummary, len(raw))
	for i, r := range raw {
		tasks := make([]TaskSummary, len(r.Tasks))
		for j, t := range r.Tasks {
			tasks[j] = TaskSummary{
				Slug:      t.Slug,
				EpicSlug:  r.Slug,
				Status:    t.Status,
				DependsOn: t.DependsOn,
			}
		}
		summaries[i] = EpicSummary{
			Slug:      r.Slug,
			Name:      r.Name,
			Status:    r.Status,
			Completed: r.Completed,
			Total:     r.Total,
			Tasks:     tasks,
		}
	}
	return summaries
}

func (ds *fileDataSource) Tasks() []TaskSummary {
	// Collect tasks from epics.
	epicTasks := make(map[string]string) // taskSlug -> epicSlug
	for _, e := range epic.ListAll(ds.projectPath) {
		for _, t := range e.Tasks {
			epicTasks[t.Slug] = e.Slug
		}
	}

	// List all spec tasks.
	state, err := spec.ReadActiveState(ds.projectPath)
	if err != nil {
		return nil
	}

	var tasks []TaskSummary
	for _, at := range state.Tasks {
		sd := &spec.SpecDir{ProjectPath: ds.projectPath, TaskSlug: at.Slug}
		status := "unknown"
		if sd.Exists() {
			if session, err := sd.ReadFile(spec.FileSession); err == nil {
				status = extractStatus(session)
			}
		}
		tasks = append(tasks, TaskSummary{
			Slug:     at.Slug,
			EpicSlug: epicTasks[at.Slug],
			Status:   status,
		})
	}
	return tasks
}

func (ds *fileDataSource) Specs() []SpecEntry {
	state, err := spec.ReadActiveState(ds.projectPath)
	if err != nil {
		return nil
	}

	var entries []SpecEntry
	for _, at := range state.Tasks {
		sd := &spec.SpecDir{ProjectPath: ds.projectPath, TaskSlug: at.Slug}
		if !sd.Exists() {
			continue
		}
		for _, f := range spec.AllFiles {
			content, err := sd.ReadFile(f)
			if err != nil {
				continue
			}
			entries = append(entries, SpecEntry{
				TaskSlug: at.Slug,
				File:     string(f),
				Size:     int64(len(content)),
			})
		}
	}
	return entries
}

func (ds *fileDataSource) SpecContent(taskSlug, file string) string {
	sd := &spec.SpecDir{ProjectPath: ds.projectPath, TaskSlug: taskSlug}
	content, err := sd.ReadFile(spec.SpecFile(file))
	if err != nil {
		return "(not found)"
	}
	return content
}

func (ds *fileDataSource) Memories(limit int) []MemoryEntry {
	if ds.st == nil {
		return nil
	}
	docs, err := ds.st.SearchMemoriesKeyword(context.TODO(), "", limit)
	if err != nil {
		return nil
	}
	return docsToMemories(docs)
}

func (ds *fileDataSource) SearchMemories(query string) []MemoryEntry {
	if ds.st == nil || query == "" {
		return ds.Memories(50)
	}
	docs, err := ds.st.SearchMemoriesKeyword(context.TODO(), query, 50)
	if err != nil {
		return nil
	}
	return docsToMemories(docs)
}

func docsToMemories(docs []store.DocRow) []MemoryEntry {
	now := time.Now()
	entries := make([]MemoryEntry, 0, len(docs))
	for _, d := range docs {
		age := time.Duration(0)
		if t, err := time.Parse(time.RFC3339, d.CrawledAt); err == nil {
			age = now.Sub(t)
		} else if t, err := time.Parse("2006-01-02 15:04:05", d.CrawledAt); err == nil {
			age = now.Sub(t)
		}
		entries = append(entries, MemoryEntry{
			Label:   d.SectionPath,
			Project: extractProject(d.URL),
			Content: d.Content,
			Age:     age,
		})
	}
	return entries
}

// extractProject extracts project name from URL like "memory://user/project/..."
func extractProject(url string) string {
	// Split on "/" and filter empty parts.
	parts := strings.FieldsFunc(url, func(r rune) bool { return r == '/' })
	// URL like "memory:" "user" "project" "..." → parts[2] is project
	if len(parts) >= 3 {
		return parts[2]
	}
	return "general"
}

// extractStatus parses "## Status\n<value>" from session.md content.
func extractStatus(session string) string {
	foundHeader := false
	for line := range strings.SplitSeq(session, "\n") {
		line = strings.TrimSpace(line)
		if line == "## Status" {
			foundHeader = true
			continue
		}
		if foundHeader && line != "" && !strings.HasPrefix(line, "#") {
			return line
		}
	}
	return "active"
}
