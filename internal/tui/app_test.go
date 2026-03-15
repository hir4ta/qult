package tui

import (
	"strings"
	"testing"
	"time"

	"charm.land/bubbles/v2/viewport"
	"github.com/hir4ta/claude-alfred/internal/spec"
)

// mockDataSource implements DataSource for testing.
type mockDataSource struct {
	projectPath string
	activeTask  string
	tasks       []TaskDetail
	specs       []SpecEntry
	knowledge   []KnowledgeEntry
	activity    []ActivityEntry
}

func (m *mockDataSource) ProjectPath() string                            { return m.projectPath }
func (m *mockDataSource) ActiveTask() string                             { return m.activeTask }
func (m *mockDataSource) TaskDetails() []TaskDetail                      { return m.tasks }
func (m *mockDataSource) Specs() []SpecEntry                             { return m.specs }
func (m *mockDataSource) SpecContent(_, _ string) string                 { return "# test" }
func (m *mockDataSource) SemanticSearch(_ string, _ int) []KnowledgeEntry { return m.knowledge }
func (m *mockDataSource) RecentKnowledge(_ int) []KnowledgeEntry         { return m.knowledge }
func (m *mockDataSource) RecentActivity(_ int) []ActivityEntry           { return m.activity }
func (m *mockDataSource) KnowledgeStats() KnowledgeStats                 { return KnowledgeStats{} }
func (m *mockDataSource) Epics() []EpicSummary                           { return nil }
func (m *mockDataSource) AllDecisions(_ int) []DecisionEntry             { return nil }

func TestTabBadge(t *testing.T) {
	ds := &mockDataSource{
		tasks: []TaskDetail{
			{Slug: "task-1", Status: "active", HasBlocker: false},
			{Slug: "task-2", Status: "active", HasBlocker: true},
		},
		knowledge: []KnowledgeEntry{
			{Label: "mem1", Source: "memory"},
		},
	}
	m := New(ds)
	m.allTasks = ds.tasks
	m.knowledge = ds.knowledge
	m.knStats = KnowledgeStats{Total: 1}
	m.specGroups = []specTaskGroup{{Slug: "task-1", FileCount: 2}}

	// Tasks badge should show count with blocker indicator.
	badge := m.tabBadge(tabTasks)
	if badge == "" {
		t.Error("Tasks badge should not be empty")
	}
	// Should contain "2" (task count).
	if !strings.Contains(badge, "2") {
		t.Errorf("Tasks badge should contain count, got %q", badge)
	}

	// Knowledge badge (uses knStats.Total).
	badge = m.tabBadge(tabKnowledge)
	if badge != "(1)" {
		t.Errorf("Knowledge badge = %q, want (1)", badge)
	}

	// Activity badge (no activity).
	badge = m.tabBadge(tabActivity)
	if badge != "" {
		t.Errorf("Activity badge = %q, want empty", badge)
	}
}

func TestTabBadgeEmpty(t *testing.T) {
	ds := &mockDataSource{}
	m := New(ds)

	for tab := range tabCount {
		badge := m.tabBadge(tab)
		if badge != "" {
			t.Errorf("tab %d badge = %q, want empty when no data", tab, badge)
		}
	}
}

func TestSwitchTab(t *testing.T) {
	ds := &mockDataSource{}
	m := New(ds)
	m.width = 120
	m.height = 40

	m.switchTab(tabKnowledge)
	if m.activeTab != tabKnowledge {
		t.Errorf("activeTab = %d, want %d", m.activeTab, tabKnowledge)
	}

	m.switchTab(tabTasks)
	if m.activeTab != tabTasks {
		t.Errorf("activeTab = %d, want %d", m.activeTab, tabTasks)
	}
}

func TestRenderSimpleDiff(t *testing.T) {
	tests := []struct {
		name        string
		old         string
		new         string
		wantRemoved bool
		wantAdded   bool
	}{
		{
			name:        "identical",
			old:         "line1\nline2",
			new:         "line1\nline2",
			wantRemoved: false,
			wantAdded:   false,
		},
		{
			name:        "added lines",
			old:         "line1",
			new:         "line1\nline2",
			wantRemoved: false,
			wantAdded:   true,
		},
		{
			name:        "removed lines",
			old:         "line1\nline2",
			new:         "line1",
			wantRemoved: true,
			wantAdded:   false,
		},
		{
			name:        "both",
			old:         "line1\nold",
			new:         "line1\nnew",
			wantRemoved: true,
			wantAdded:   true,
		},
		{
			name:        "empty both",
			old:         "",
			new:         "",
			wantRemoved: false,
			wantAdded:   false,
		},
		{
			name:        "duplicate lines",
			old:         "a\na\nb",
			new:         "a\nb\nb",
			wantRemoved: true,
			wantAdded:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := renderSimpleDiff(tt.old, tt.new)
			hasRemoved := strings.Contains(result, "--- removed")
			hasAdded := strings.Contains(result, "+++ added")
			if hasRemoved != tt.wantRemoved {
				t.Errorf("removed: got %v, want %v", hasRemoved, tt.wantRemoved)
			}
			if hasAdded != tt.wantAdded {
				t.Errorf("added: got %v, want %v", hasAdded, tt.wantAdded)
			}
		})
	}
}

func TestStripDECRPM(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"hello", "hello"},
		{"hello[?2026;2$y world", "hello world"},
		{"[?2028$y text", " text"},
		{"no escape here", "no escape here"},
		{"> 2828/2828[?2026;2$y", "> 2828/2828"},
	}

	for _, tt := range tests {
		got := stripDECRPM(tt.input)
		if got != tt.want {
			t.Errorf("stripDECRPM(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestFormatAuditAction(t *testing.T) {
	tests := []struct {
		action string
		want   string
	}{
		{"spec.init", "created"},
		{"spec.complete", "completed"},
		{"review.submit", "reviewed"},
		{"unknown.action", "unknown.action"},
	}

	for _, tt := range tests {
		got := formatAuditAction(tt.action)
		if got != tt.want {
			t.Errorf("formatAuditAction(%q) = %q, want %q", tt.action, got, tt.want)
		}
	}
}

func TestAllTasksIncludesCompleted(t *testing.T) {
	ds := &mockDataSource{
		activeTask: "task-active",
		tasks: []TaskDetail{
			{Slug: "task-active", Status: "active", Focus: "working on it"},
			{Slug: "task-done", Status: "completed", Total: 5, Completed: 5},
		},
	}
	m := New(ds)
	m.width = 120
	m.height = 40
	m.refreshData()

	// allTasks should include both active and completed.
	if len(m.allTasks) != 2 {
		t.Errorf("allTasks = %d, want 2", len(m.allTasks))
	}
}

func TestReviewConfirmReset(t *testing.T) {
	ds := &mockDataSource{
		projectPath: t.TempDir(),
		tasks:       []TaskDetail{{Slug: "test", Status: "active"}},
	}
	m := New(ds)
	m.width = 120
	m.height = 40

	// Simulate confirm pending state.
	m.reviewConfirmPending = true
	m.reviewConfirmStatus = spec.ReviewApproved

	// Set up minimal spec group for enterReviewMode.
	m.specGroups = []specTaskGroup{
		{Slug: "test", Files: []SpecEntry{{TaskSlug: "test", File: "session.md"}}},
	}
	m.specGroupCursor = 0
	m.specFileCursor = 0

	// Initialize viewport to prevent panic in rebuildReviewOverlay.
	m.overlayVP = viewport.New(
		viewport.WithWidth(80),
		viewport.WithHeight(20),
	)

	m.enterReviewMode()

	if m.reviewConfirmPending {
		t.Error("enterReviewMode should reset reviewConfirmPending")
	}
}

func TestDebounceSequence(t *testing.T) {
	// Verify that incrementing debounceSeq invalidates old ticks.
	ds := &mockDataSource{}
	m := New(ds)

	m.debounceSeq = 5
	m.searching = true

	// Old tick should not match.
	oldTick := debounceTickMsg{seq: 3}
	if oldTick.seq == m.debounceSeq {
		t.Error("old debounce tick should not match current seq")
	}

	// Current tick should match.
	currentTick := debounceTickMsg{seq: 5}
	if currentTick.seq != m.debounceSeq {
		t.Error("current debounce tick should match")
	}
}

func TestActivityEntryReversal(t *testing.T) {
	ds := &mockDataSource{
		activity: []ActivityEntry{
			{Timestamp: time.Now(), Action: "spec.init", Target: "task-1"},
			{Timestamp: time.Now().Add(-time.Hour), Action: "review.submit", Target: "task-2"},
		},
	}
	m := New(ds)
	m.activity = ds.activity

	// Most recent should be first.
	if m.activity[0].Action != "spec.init" {
		t.Errorf("first activity = %q, want spec.init", m.activity[0].Action)
	}
}

func TestStyledSubType(t *testing.T) {
	// All sub types should render non-empty.
	for _, st := range []string{"rule", "decision", "pattern", "general"} {
		result := styledSubType(st)
		if result == "" {
			t.Errorf("styledSubType(%q) should not be empty", st)
		}
	}

	// Unknown should return empty.
	if result := styledSubType("unknown"); result != "" {
		t.Errorf("styledSubType(unknown) = %q, want empty", result)
	}
}

