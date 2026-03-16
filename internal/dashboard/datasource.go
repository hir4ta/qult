package dashboard

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/epic"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// fileDataSource implements DataSource by reading .alfred/ files and SQLite.
type fileDataSource struct {
	projectPath string
	st          *store.Store
	emb         *embedder.Embedder

	// Conflict detection cache (DEC-6: 60s TTL).
	conflictMu    sync.Mutex
	conflictCount int
	conflictAt    time.Time
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
	epicTasks := make(map[string]string)
	for _, e := range epic.ListAll(ds.projectPath) {
		for _, t := range e.Tasks {
			epicTasks[t.Slug] = e.Slug
		}
	}

	state, err := spec.ReadActiveState(ds.projectPath)
	if err != nil {
		return nil
	}

	active := make([]TaskDetail, 0, len(state.Tasks))
	completed := make([]TaskDetail, 0)
	for _, at := range state.Tasks {
		sd := &spec.SpecDir{ProjectPath: ds.projectPath, TaskSlug: at.Slug}
		td := TaskDetail{
			Slug:         at.Slug,
			EpicSlug:     epicTasks[at.Slug],
			Status:       "unknown",
			StartedAt:    at.StartedAt,
			CompletedAt:  at.CompletedAt,
			Size:         string(at.EffectiveSize()),
			SpecType:     string(at.EffectiveSpecType()),
			ReviewStatus: string(at.ReviewStatus),
		}

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
			entry := SpecEntry{
				TaskSlug: at.Slug,
				File:     string(f),
				Size:     int64(len(content)),
			}
			if info, err := os.Stat(sd.FilePath(f)); err == nil {
				entry.UpdatedAt = info.ModTime()
			}
			entries = append(entries, entry)
		}
	}
	return entries
}

func (ds *fileDataSource) SpecContent(taskSlug, file string) (string, error) {
	sd := &spec.SpecDir{ProjectPath: ds.projectPath, TaskSlug: taskSlug}
	content, err := sd.ReadFile(spec.SpecFile(file))
	if err != nil {
		return "", fmt.Errorf("spec file not found: %s/%s", taskSlug, file)
	}
	return content, nil
}

func (ds *fileDataSource) SemanticSearch(ctx context.Context, query string, limit int) []KnowledgeEntry {
	if ds.emb == nil || ds.st == nil {
		return nil
	}

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
	if ds.st != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		docs, err := ds.st.ListAllMemories(ctx, limit)
		if err == nil && len(docs) > 0 {
			entries := make([]KnowledgeEntry, 0, len(docs))
			for _, d := range docs {
				savedAt := d.CrawledAt
				entries = append(entries, KnowledgeEntry{
					ID:         d.ID,
					Label:      d.SectionPath,
					Source:     d.SourceType,
					SubType:    d.SubType,
					HitCount:   d.HitCount,
					Content:    d.Content,
					Structured: d.Structured,
					SavedAt:    savedAt,
					Enabled:    d.Enabled,
				})
			}
			return entries
		}
	}

	var entries []KnowledgeEntry

	decs, _ := store.LoadDecisions(ds.projectPath)
	for _, d := range decs {
		entries = append(entries, KnowledgeEntry{
			Label:   d.Title,
			Source:  "memory",
			SubType: "decision",
			Content: d.ToContent(),
			Enabled: true,
		})
	}

	pats, _ := store.LoadPatterns(ds.projectPath)
	for _, p := range pats {
		entries = append(entries, KnowledgeEntry{
			Label:   p.Title,
			Source:  "memory",
			SubType: "pattern",
			Content: p.ToContent(),
			Enabled: true,
		})
	}

	rules, _ := store.LoadRules(ds.projectPath)
	for _, r := range rules {
		entries = append(entries, KnowledgeEntry{
			Label:   r.Text,
			Source:  "memory",
			SubType: "rule",
			Content: r.ToContent(),
			Enabled: true,
		})
	}

	sessions, _ := store.LoadSessions(ds.projectPath)
	for _, s := range sessions {
		entries = append(entries, KnowledgeEntry{
			Label:   s.Title,
			Source:  "memory",
			SubType: "general",
			Content: s.ToContent(),
			Enabled: true,
		})
	}

	if len(entries) > limit {
		entries = entries[:limit]
	}
	return entries
}

func (ds *fileDataSource) RecentActivity(limit int) []ActivityEntry {
	entries, err := spec.ReadAuditLog(ds.projectPath, limit)
	if err != nil || len(entries) == 0 {
		return nil
	}
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

func (ds *fileDataSource) KnowledgeStats() KnowledgeStats {
	var ks KnowledgeStats
	decs, _ := store.LoadDecisions(ds.projectPath)
	ks.Decision = len(decs)
	pats, _ := store.LoadPatterns(ds.projectPath)
	ks.Pattern = len(pats)
	rules, _ := store.LoadRules(ds.projectPath)
	ks.Rule = len(rules)
	sessions, _ := store.LoadSessions(ds.projectPath)
	ks.General = len(sessions)
	ks.Total = ks.Decision + ks.Pattern + ks.Rule + ks.General
	return ks
}

func (ds *fileDataSource) Epics() []EpicSummary {
	epics := epic.ListAll(ds.projectPath)
	if len(epics) == 0 {
		return nil
	}

	taskStatus := make(map[string]string)
	if state, err := spec.ReadActiveState(ds.projectPath); err == nil {
		for _, t := range state.Tasks {
			if t.Status == spec.TaskCompleted {
				taskStatus[t.Slug] = "completed"
			} else {
				taskStatus[t.Slug] = "active"
			}
		}
	}

	summaries := make([]EpicSummary, 0, len(epics))
	for _, e := range epics {
		es := EpicSummary{
			Slug:   e.Slug,
			Name:   e.Name,
			Status: e.Status,
			Total:  len(e.Tasks),
		}
		for _, t := range e.Tasks {
			status := t.Status
			if s, ok := taskStatus[t.Slug]; ok {
				status = s
			}
			es.Tasks = append(es.Tasks, EpicTaskSummary{
				Slug:   t.Slug,
				Status: status,
			})
			if status == "completed" {
				es.Completed++
			}
		}
		summaries = append(summaries, es)
	}
	return summaries
}

func (ds *fileDataSource) AllDecisions(limit int) []DecisionEntry {
	state, err := spec.ReadActiveState(ds.projectPath)
	if err != nil {
		return nil
	}

	var entries []DecisionEntry
	for _, at := range state.Tasks {
		sd := &spec.SpecDir{ProjectPath: ds.projectPath, TaskSlug: at.Slug}
		content, err := sd.ReadFile(spec.FileDecisions)
		if err != nil {
			continue
		}

		_, ordered := splitSectionsOrdered(content)
		for _, sec := range ordered {
			if sec.header == "" {
				continue
			}
			de := DecisionEntry{TaskSlug: at.Slug}

			title := sec.header
			if len(title) > 13 && title[0] == '[' {
				if idx := strings.Index(title, "] "); idx > 0 {
					title = title[idx+2:]
				}
			}
			de.Title = title

			for line := range strings.SplitSeq(sec.body, "\n") {
				trimmed := strings.TrimSpace(line)
				if strings.HasPrefix(trimmed, "- **Chosen:**") || strings.HasPrefix(trimmed, "**Chosen:**") {
					de.Chosen = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(trimmed, "- "), "**Chosen:**"))
				} else if strings.HasPrefix(trimmed, "- **Alternatives:**") || strings.HasPrefix(trimmed, "**Alternatives:**") {
					de.Alternatives = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(trimmed, "- "), "**Alternatives:**"))
				} else if strings.HasPrefix(trimmed, "- **Reason:**") || strings.HasPrefix(trimmed, "**Reason:**") {
					de.Reason = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(trimmed, "- "), "**Reason:**"))
				}
			}

			entries = append(entries, de)
		}
	}

	if limit > 0 && len(entries) > limit {
		entries = entries[:limit]
	}
	return entries
}

func (ds *fileDataSource) ToggleEnabled(id int64, enabled bool) error {
	if ds.st == nil {
		return fmt.Errorf("no database connection")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return ds.st.SetEnabled(ctx, id, enabled)
}

func (ds *fileDataSource) Validation(taskSlug string) *spec.ValidationReport {
	state, err := spec.ReadActiveState(ds.projectPath)
	if err != nil {
		return nil
	}
	sd := &spec.SpecDir{ProjectPath: ds.projectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		return nil
	}
	size := spec.SizeL
	specType := spec.TypeFeature
	for _, t := range state.Tasks {
		if t.Slug == taskSlug {
			size = t.EffectiveSize()
			specType = t.EffectiveSpecType()
			break
		}
	}
	report, err := spec.Validate(sd, size, specType)
	if err != nil {
		return nil
	}
	return report
}

func (ds *fileDataSource) MemoryHealth() MemoryHealthStats {
	var stats MemoryHealthStats
	if ds.st == nil {
		return stats
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	docs, err := ds.st.ListAllMemories(ctx, 1000)
	if err == nil {
		stats.Total = len(docs)

		// Compute vitality distribution: 5 buckets (0-20, 21-40, 41-60, 61-80, 81-100).
		now := time.Now()
		for _, d := range docs {
			v := store.ComputeVitalityFromDoc(&d, now)
			bucket := int(v.Total / 20)
			if bucket > 4 {
				bucket = 4
			}
			if bucket < 0 {
				bucket = 0
			}
			stats.VitalityDist[bucket]++
		}
	}

	lowDocs, err := ds.st.ListLowVitality(ctx, 20, 1000)
	if err == nil {
		stats.StaleCount = len(lowDocs)
	}

	ds.conflictMu.Lock()
	if time.Since(ds.conflictAt) > 60*time.Second {
		conflicts, err := ds.st.DetectConflicts(ctx, 0.70)
		if err == nil {
			count := 0
			for _, c := range conflicts {
				if c.Type == "potential_contradiction" {
					count++
				}
			}
			ds.conflictCount = count
		}
		ds.conflictAt = time.Now()
	}
	stats.ConflictCount = ds.conflictCount
	ds.conflictMu.Unlock()

	return stats
}

func (ds *fileDataSource) ConfidenceStats(taskSlug string) *spec.ConfidenceSummary {
	sd := &spec.SpecDir{ProjectPath: ds.projectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		return nil
	}
	primaryFile := spec.FileRequirements
	if state, err := spec.ReadActiveState(ds.projectPath); err == nil {
		for _, t := range state.Tasks {
			if t.Slug == taskSlug {
				switch t.EffectiveSpecType() {
				case spec.TypeBugfix:
					primaryFile = spec.FileBugfix
				case spec.TypeDelta:
					primaryFile = spec.FileDelta
				}
				break
			}
		}
	}
	content, err := sd.ReadFile(primaryFile)
	if err != nil {
		return nil
	}
	cs := spec.ParseConfidence(content)
	if cs.Total == 0 {
		return nil
	}
	return &cs
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func docsToKnowledge(docs []store.DocRow, scoreMap map[int64]float64, limit int) []KnowledgeEntry {
	entries := make([]KnowledgeEntry, 0, min(limit, len(docs)))
	for _, d := range docs {
		if len(entries) >= limit {
			break
		}
		score := 0.0
		if scoreMap != nil {
			score = scoreMap[d.ID]
		}
		entries = append(entries, KnowledgeEntry{
			ID:         d.ID,
			Label:      d.SectionPath,
			Source:     d.SourceType,
			SubType:    d.SubType,
			HitCount:   d.HitCount,
			Content:    d.Content,
			Structured: d.Structured,
			Score:      score,
			SavedAt:    d.CrawledAt,
			Enabled:    d.Enabled,
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

	if v, ok := sections["Next Steps"]; ok {
		ps.nextSteps = parseCheckboxes(v)
	}
	for header, v := range sections {
		if strings.HasPrefix(header, "Completed") {
			completed := parseCheckboxes(v)
			ps.nextSteps = append(completed, ps.nextSteps...)
			break
		}
	}

	for header, v := range sections {
		if strings.HasPrefix(header, "Recent Decisions") {
			ps.decisions = parseNumberedList(v)
			break
		}
	}

	if v, ok := sections["Blockers"]; ok {
		text := stripHTMLComments(strings.TrimSpace(v))
		lower := strings.ToLower(text)
		if text != "" && lower != "none" && lower != "none." && lower != "なし" {
			ps.hasBlocker = true
			ps.blockerText = firstNonEmptyLine(text)
		}
	}

	for header, v := range sections {
		if strings.HasPrefix(header, "Modified Files") {
			ps.modFiles = parseBulletList(v)
			break
		}
	}

	return ps
}

type orderedSection struct {
	header string
	body   string
}

func splitSections(content string) map[string]string {
	sections, _ := splitSectionsOrdered(content)
	return sections
}

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
				ordered = append(ordered, orderedSection{header: currentHeader, body: b})
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
		ordered = append(ordered, orderedSection{header: currentHeader, body: b})
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

var htmlCommentRe = regexp.MustCompile(`(?s)<!--.*?-->`)

func stripHTMLComments(s string) string {
	return strings.TrimSpace(htmlCommentRe.ReplaceAllString(s, ""))
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
