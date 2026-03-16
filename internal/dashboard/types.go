// Package dashboard provides the DataSource interface and types shared between
// the HTTP API server and the browser dashboard.
package dashboard

import (
	"context"
	"time"

	"github.com/hir4ta/claude-alfred/internal/spec"
)

// StepItem is a checkbox item from Next Steps.
type StepItem struct {
	Text string `json:"text"`
	Done bool   `json:"done"`
}

// TaskDetail holds rich parsed data for a single task.
type TaskDetail struct {
	Slug         string     `json:"slug"`
	EpicSlug     string     `json:"epic_slug,omitempty"`
	Status       string     `json:"status"`
	Focus        string     `json:"focus,omitempty"`
	Completed    int        `json:"completed"`
	Total        int        `json:"total"`
	HasBlocker   bool       `json:"has_blocker"`
	BlockerText  string     `json:"blocker_text,omitempty"`
	Decisions    []string   `json:"decisions,omitempty"`
	NextSteps    []StepItem `json:"next_steps,omitempty"`
	ModFiles     []string   `json:"mod_files,omitempty"`
	StartedAt    string     `json:"started_at,omitempty"`
	CompletedAt  string     `json:"completed_at,omitempty"`
	Size         string     `json:"size,omitempty"`
	SpecType     string     `json:"spec_type,omitempty"`
	ReviewStatus string     `json:"review_status,omitempty"`
}

// SpecEntry holds display data for a spec file.
type SpecEntry struct {
	TaskSlug  string    `json:"task_slug"`
	File      string    `json:"file"`
	Size      int64     `json:"size"`
	UpdatedAt time.Time `json:"updated_at"`
}

// KnowledgeEntry holds a search/browse result.
type KnowledgeEntry struct {
	ID         int64   `json:"id"`
	Label      string  `json:"label"`
	Source     string  `json:"source"`
	SubType    string  `json:"sub_type"`
	HitCount   int     `json:"hit_count"`
	Content    string  `json:"content"`
	Structured string  `json:"structured,omitempty"`
	Score      float64 `json:"score,omitempty"`
	SavedAt    string  `json:"saved_at,omitempty"`
	Enabled    bool    `json:"enabled"`
}

// ActivityEntry holds a timeline event from audit.jsonl.
type ActivityEntry struct {
	Timestamp time.Time `json:"timestamp"`
	Action    string    `json:"action"`
	Target    string    `json:"target"`
	Detail    string    `json:"detail,omitempty"`
}

// KnowledgeStats holds memory counts by sub_type.
type KnowledgeStats struct {
	Total    int `json:"total"`
	Decision int `json:"decision"`
	Pattern  int `json:"pattern"`
	Rule     int `json:"rule"`
	General  int `json:"general"`
}

// EpicSummary holds display data for an epic.
type EpicSummary struct {
	Slug      string            `json:"slug"`
	Name      string            `json:"name"`
	Status    string            `json:"status"`
	Completed int               `json:"completed"`
	Total     int               `json:"total"`
	Tasks     []EpicTaskSummary `json:"tasks,omitempty"`
}

// EpicTaskSummary holds a task's status within an epic.
type EpicTaskSummary struct {
	Slug   string `json:"slug"`
	Status string `json:"status"`
}

// DecisionEntry holds a single decision from decisions.md across all tasks.
type DecisionEntry struct {
	TaskSlug     string `json:"task_slug"`
	Title        string `json:"title"`
	Chosen       string `json:"chosen,omitempty"`
	Alternatives string `json:"alternatives,omitempty"`
	Reason       string `json:"reason,omitempty"`
}

// MemoryHealthStats holds overview-level memory health data.
type MemoryHealthStats struct {
	Total         int    `json:"total"`
	StaleCount    int    `json:"stale_count"`
	ConflictCount int    `json:"conflict_count"`
	VitalityDist  [5]int `json:"vitality_dist"`
}

// DataSource abstracts data retrieval for the dashboard.
type DataSource interface {
	ProjectPath() string
	ActiveTask() string
	TaskDetails() []TaskDetail
	Specs() []SpecEntry
	SpecContent(taskSlug, file string) (string, error)
	SemanticSearch(ctx context.Context, query string, limit int) []KnowledgeEntry
	RecentKnowledge(limit int) []KnowledgeEntry
	RecentActivity(limit int) []ActivityEntry
	KnowledgeStats() KnowledgeStats
	Epics() []EpicSummary
	AllDecisions(limit int) []DecisionEntry
	ToggleEnabled(id int64, enabled bool) error
	Validation(taskSlug string) *spec.ValidationReport
	MemoryHealth() MemoryHealthStats
	ConfidenceStats(taskSlug string) *spec.ConfidenceSummary
}
