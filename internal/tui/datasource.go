package tui

import (
	"context"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/epic"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// StepItem is a checkbox item from Next Steps.
type StepItem struct {
	Text string
	Done bool
}

// TaskDetail holds rich parsed data for a single task.
type TaskDetail struct {
	Slug        string
	EpicSlug    string
	Status      string
	Focus       string     // first line of Currently Working On
	Completed   int        // checked [x] items in Next Steps
	Total       int        // total checkbox items
	HasBlocker  bool
	BlockerText string
	Decisions   []string
	NextSteps   []StepItem
	ModFiles    []string
}

// SpecEntry holds display data for a spec file.
type SpecEntry struct {
	TaskSlug  string
	File      string
	Size      int64
	UpdatedAt time.Time
}

// KnowledgeEntry holds a search/browse result.
type KnowledgeEntry struct {
	Label    string
	Source   string  // "memory", "spec", "project"
	SubType  string  // "general", "decision", "pattern", "rule"
	HitCount int
	Content  string
	Score    float64 // vector similarity (0 if not from search)
	Age      time.Duration
}

// ActivityEntry holds a timeline event from audit.jsonl.
type ActivityEntry struct {
	Timestamp time.Time
	Action    string // "spec.init", "review.submit", etc.
	Target    string // task slug or path
	Detail    string
}

// DataSource abstracts data retrieval for the TUI.
type DataSource interface {
	ProjectPath() string
	ActiveTask() string
	TaskDetails() []TaskDetail
	Specs() []SpecEntry
	SpecContent(taskSlug, file string) string
	SemanticSearch(query string, limit int) []KnowledgeEntry
	RecentKnowledge(limit int) []KnowledgeEntry
	RecentActivity(limit int) []ActivityEntry
}

// fileDataSource implements DataSource by reading .alfred/ files and SQLite.
type fileDataSource struct {
	projectPath string
	st          *store.Store
	emb         *embedder.Embedder
}

// NewFileDataSource creates a DataSource backed by filesystem + SQLite + Voyage.
func NewFileDataSource(projectPath string, st *store.Store, emb *embedder.Embedder) DataSource {
	return &fileDataSource{projectPath: projectPath, st: st, emb: emb}
}

func (ds *fileDataSource) ProjectPath() string { return ds.projectPath }

func (ds *fileDataSource) ActiveTask() string {
	state, err := spec.ReadActiveState(ds.projectPath)
	if err != nil {
		return ""
	}
	// If primary is completed, find first active task.
	for _, t := range state.Tasks {
		if t.Slug == state.Primary && t.IsActive() {
			return state.Primary
		}
	}
	for _, t := range state.Tasks {
		if t.IsActive() {
			return t.Slug
		}
	}
	return ""
}

func (ds *fileDataSource) TaskDetails() []TaskDetail {
	epicTasks := make(map[string]string) // taskSlug -> epicSlug
	for _, e := range epic.ListAll(ds.projectPath) {
		for _, t := range e.Tasks {
			epicTasks[t.Slug] = e.Slug
		}
	}

	state, err := spec.ReadActiveState(ds.projectPath)
	if err != nil {
		return nil
	}

	// Sort: active tasks first, completed last.
	active := make([]TaskDetail, 0, len(state.Tasks))
	completed := make([]TaskDetail, 0)
	for _, at := range state.Tasks {
		sd := &spec.SpecDir{ProjectPath: ds.projectPath, TaskSlug: at.Slug}
		td := TaskDetail{
			Slug:     at.Slug,
			EpicSlug: epicTasks[at.Slug],
			Status:   "unknown",
		}

		// Use lifecycle status from _active.md if set.
		if at.Status == spec.TaskCompleted {
			td.Status = "completed"
		}

		if sd.Exists() {
			if session, err := sd.ReadFile(spec.FileSession); err == nil {
				parsed := parseSessionSections(session)
				if td.Status == "unknown" {
					td.Status = parsed.status
				}
				td.Focus = parsed.focus
				td.NextSteps = parsed.nextSteps
				td.Decisions = parsed.decisions
				td.ModFiles = parsed.modFiles
				td.HasBlocker = parsed.hasBlocker
				td.BlockerText = parsed.blockerText

				for _, s := range td.NextSteps {
					td.Total++
					if s.Done {
						td.Completed++
					}
				}
			}
		}

		if at.Status == spec.TaskCompleted {
			completed = append(completed, td)
		} else {
			active = append(active, td)
		}
	}
	return append(active, completed...)
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

func (ds *fileDataSource) SemanticSearch(query string, limit int) []KnowledgeEntry {
	if ds.emb == nil || ds.st == nil {
		return nil
	}
	ctx := context.Background()

	vec, err := ds.emb.EmbedForSearch(ctx, query)
	if err != nil || vec == nil {
		return nil
	}

	matches, err := ds.st.VectorSearch(ctx, vec, "records", limit*3,
		store.SourceMemory, store.SourceSpec, store.SourceProject)
	if err != nil || len(matches) == 0 {
		return nil
	}

	ids := make([]int64, len(matches))
	scoreMap := make(map[int64]float64)
	for i, m := range matches {
		ids[i] = m.SourceID
		scoreMap[m.SourceID] = m.Score
	}

	docs, err := ds.st.GetDocsByIDs(ctx, ids)
	if err != nil {
		return nil
	}

	// Rerank for quality.
	if len(docs) > 1 {
		contents := make([]string, len(docs))
		for i, d := range docs {
			contents[i] = d.SectionPath + ": " + d.Content
		}
		reranked, err := ds.emb.Rerank(ctx, query, contents, min(limit, len(docs)))
		if err == nil && len(reranked) > 0 {
			reordered := make([]store.DocRow, len(reranked))
			for i, r := range reranked {
				reordered[i] = docs[r.Index]
				scoreMap[docs[r.Index].ID] = r.RelevanceScore
			}
			docs = reordered
		}
	}

	return docsToKnowledge(docs, scoreMap, limit)
}

func (ds *fileDataSource) RecentKnowledge(limit int) []KnowledgeEntry {
	if ds.st == nil {
		return nil
	}
	docs, err := ds.st.SearchMemoriesKeyword(context.Background(), "", limit)
	if err != nil {
		return nil
	}
	return docsToKnowledge(docs, nil, limit)
}

func (ds *fileDataSource) RecentActivity(limit int) []ActivityEntry {
	entries, err := spec.ReadAuditLog(ds.projectPath, limit)
	if err != nil || len(entries) == 0 {
		return nil
	}
	// Reverse: most recent first.
	result := make([]ActivityEntry, 0, len(entries))
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		t, _ := time.Parse(time.RFC3339, e.Timestamp)
		result = append(result, ActivityEntry{
			Timestamp: t,
			Action:    e.Action,
			Target:    e.Target,
			Detail:    e.Detail,
		})
	}
	return result
}

func docsToKnowledge(docs []store.DocRow, scoreMap map[int64]float64, limit int) []KnowledgeEntry {
	now := time.Now()
	entries := make([]KnowledgeEntry, 0, min(limit, len(docs)))
	for _, d := range docs {
		if len(entries) >= limit {
			break
		}
		age := time.Duration(0)
		if t, err := time.Parse(time.RFC3339, d.CrawledAt); err == nil {
			age = now.Sub(t)
		} else if t, err := time.Parse("2006-01-02 15:04:05", d.CrawledAt); err == nil {
			age = now.Sub(t)
		}
		score := 0.0
		if scoreMap != nil {
			score = scoreMap[d.ID]
		}
		entries = append(entries, KnowledgeEntry{
			Label:    d.SectionPath,
			Source:   d.SourceType,
			SubType:  d.SubType,
			HitCount: d.HitCount,
			Content:  d.Content,
			Score:    score,
			Age:      age,
		})
	}
	return entries
}

// ---------------------------------------------------------------------------
// session.md parser
// ---------------------------------------------------------------------------

type parsedSession struct {
	status      string
	focus       string
	nextSteps   []StepItem
	decisions   []string
	modFiles    []string
	hasBlocker  bool
	blockerText string
}

func parseSessionSections(content string) parsedSession {
	sections := splitSections(content)
	ps := parsedSession{status: "active"}

	if v, ok := sections["Status"]; ok {
		if s := firstNonEmptyLine(v); s != "" {
			ps.status = s
		}
	}

	if v, ok := sections["Currently Working On"]; ok {
		ps.focus = firstNonEmptyLine(v)
	}

	// Try "Next Steps" first, then "Completed" sections for checkboxes.
	if v, ok := sections["Next Steps"]; ok {
		ps.nextSteps = parseCheckboxes(v)
	}
	if v, ok := sections["Completed"]; ok {
		completed := parseCheckboxes(v)
		ps.nextSteps = append(completed, ps.nextSteps...)
	}

	// Recent Decisions — match headers like "Recent Decisions (last 3)".
	for header, v := range sections {
		if strings.HasPrefix(header, "Recent Decisions") {
			ps.decisions = parseNumberedList(v)
			break
		}
	}

	if v, ok := sections["Blockers"]; ok {
		text := strings.TrimSpace(v)
		lower := strings.ToLower(text)
		if text != "" && lower != "none" && lower != "none." && lower != "なし" {
			ps.hasBlocker = true
			ps.blockerText = firstNonEmptyLine(text)
		}
	}

	// Modified Files — match headers with optional suffix.
	for header, v := range sections {
		if strings.HasPrefix(header, "Modified Files") {
			ps.modFiles = parseBulletList(v)
			break
		}
	}

	return ps
}

// orderedSection is a header+body pair preserving document order.
type orderedSection struct {
	Header string
	Body   string
}

// splitSections splits markdown content by ## headers.
// Returns a map for key-based access AND preserves insertion order via orderedSections.
func splitSections(content string) map[string]string {
	sections, _ := splitSectionsOrdered(content)
	return sections
}

// splitSectionsOrdered splits markdown by ## headers, preserving document order.
func splitSectionsOrdered(content string) (map[string]string, []orderedSection) {
	m := make(map[string]string)
	var ordered []orderedSection
	var currentHeader string
	var body strings.Builder

	for line := range strings.SplitSeq(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "## ") {
			if currentHeader != "" {
				b := body.String()
				m[currentHeader] = b
				ordered = append(ordered, orderedSection{Header: currentHeader, Body: b})
			}
			currentHeader = strings.TrimPrefix(trimmed, "## ")
			body.Reset()
		} else if currentHeader != "" {
			body.WriteString(line + "\n")
		}
	}
	if currentHeader != "" {
		b := body.String()
		m[currentHeader] = b
		ordered = append(ordered, orderedSection{Header: currentHeader, Body: b})
	}
	return m, ordered
}

func parseCheckboxes(text string) []StepItem {
	var items []StepItem
	for line := range strings.SplitSeq(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "- [x] ") || strings.HasPrefix(trimmed, "- [X] ") {
			items = append(items, StepItem{Text: trimmed[6:], Done: true})
		} else if strings.HasPrefix(trimmed, "- [ ] ") {
			items = append(items, StepItem{Text: trimmed[6:], Done: false})
		}
	}
	return items
}

func parseNumberedList(text string) []string {
	var items []string
	for line := range strings.SplitSeq(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if len(trimmed) > 2 && trimmed[0] >= '0' && trimmed[0] <= '9' {
			if idx := strings.Index(trimmed, ". "); idx > 0 && idx < 4 {
				items = append(items, trimmed[idx+2:])
			}
		}
	}
	return items
}

func parseBulletList(text string) []string {
	var items []string
	for line := range strings.SplitSeq(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "- ") {
			items = append(items, trimmed[2:])
		}
	}
	return items
}

func firstNonEmptyLine(s string) string {
	for line := range strings.SplitSeq(s, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			return trimmed
		}
	}
	return ""
}
