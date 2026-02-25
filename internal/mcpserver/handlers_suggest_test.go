package mcpserver

import (
	"testing"

	"github.com/hir4ta/claude-buddy/internal/analyzer"
	"github.com/hir4ta/claude-buddy/internal/parser"
)

func TestTrackFeatures(t *testing.T) {
	events := []parser.SessionEvent{
		{Type: parser.EventToolUse, ToolName: "Read", ToolInput: "/project/CLAUDE.md"},
		{Type: parser.EventToolUse, ToolName: "EnterPlanMode"},
		{Type: parser.EventToolUse, ToolName: "Task", ToolInput: "explore"},
		{Type: parser.EventToolUse, ToolName: "Skill", ToolInput: "commit"},
		{Type: parser.EventUserMessage, UserText: "hello"},
	}

	f := TrackFeatures(events)
	if !f.CLAUDEMDRead {
		t.Error("expected CLAUDEMDRead to be true")
	}
	if !f.PlanModeUsed {
		t.Error("expected PlanModeUsed to be true")
	}
	if !f.SubagentUsed {
		t.Error("expected SubagentUsed to be true")
	}
	if !f.SkillsUsed {
		t.Error("expected SkillsUsed to be true")
	}
}

func TestTrackFeaturesEmpty(t *testing.T) {
	f := TrackFeatures(nil)
	if f.PlanModeUsed || f.SubagentUsed || f.CLAUDEMDRead || f.SkillsUsed {
		t.Error("expected all features to be false for empty events")
	}
}

func TestComputeUsageHints_ShortMessages(t *testing.T) {
	events := []parser.SessionEvent{
		{Type: parser.EventUserMessage, UserText: "fix it"},
		{Type: parser.EventUserMessage, UserText: "ok"},
		{Type: parser.EventUserMessage, UserText: "yes"},
	}
	stats := analyzer.NewStats()
	for _, ev := range events {
		stats.Update(ev)
	}

	hints := ComputeUsageHints(events, stats)

	found := false
	for _, h := range hints {
		if h.Category == "instruction_quality" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected instruction_quality hint for short messages")
	}
}

func TestComputeUsageHints_NoHints(t *testing.T) {
	events := []parser.SessionEvent{
		{Type: parser.EventUserMessage, UserText: "Please refactor the database layer to use connection pooling"},
		{Type: parser.EventToolUse, ToolName: "Read", ToolInput: "db.go"},
		{Type: parser.EventToolUse, ToolName: "Edit", ToolInput: "db.go"},
	}
	stats := analyzer.NewStats()
	for _, ev := range events {
		stats.Update(ev)
	}

	hints := ComputeUsageHints(events, stats)
	if len(hints) != 0 {
		t.Errorf("expected 0 hints for well-behaved session, got %d", len(hints))
	}
}

func TestComputeUsageHints_Compaction(t *testing.T) {
	events := []parser.SessionEvent{
		{Type: parser.EventUserMessage, UserText: "start working on something long and detailed"},
		{Type: parser.EventCompactBoundary},
		{Type: parser.EventCompactBoundary},
	}
	stats := analyzer.NewStats()
	for _, ev := range events {
		stats.Update(ev)
	}

	hints := ComputeUsageHints(events, stats)
	found := false
	for _, h := range hints {
		if h.Category == "context_management" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected context_management hint for 2+ compacts")
	}
}

func TestBuildRecommendations_AlertsPrioritized(t *testing.T) {
	alerts := []analyzer.Alert{
		{Level: analyzer.LevelWarning, Observation: "retry loop detected", Suggestion: "try different approach"},
	}

	recs := BuildRecommendations(nil, FeatureUtil{PlanModeUsed: true, SubagentUsed: true, CLAUDEMDRead: true}, alerts)

	if len(recs) == 0 {
		t.Fatal("expected at least 1 recommendation")
	}
	if recs[0].Category != "anti_pattern" {
		t.Errorf("expected first rec category 'anti_pattern', got %q", recs[0].Category)
	}
	if recs[0].Priority != 1 {
		t.Errorf("expected priority 1, got %d", recs[0].Priority)
	}
}

func TestBuildRecommendations_FeatureSuggestions(t *testing.T) {
	recs := BuildRecommendations(nil, FeatureUtil{}, nil)

	// Should suggest Plan Mode/Subagent and CLAUDE.md
	categories := make(map[string]bool)
	for _, r := range recs {
		categories[r.Category] = true
	}
	if !categories["feature_suggestion"] {
		t.Error("expected feature_suggestion recommendation when no features used")
	}
}

func TestFormatTurns(t *testing.T) {
	tests := []struct {
		turns    []int
		max      int
		expected string
	}{
		{nil, 5, ""},
		{[]int{1, 3, 5}, 5, "1, 3, 5"},
		{[]int{1, 2, 3, 4, 5, 6}, 3, "1, 2, 3 (+3 more)"},
	}

	for _, tt := range tests {
		got := formatTurns(tt.turns, tt.max)
		if got != tt.expected {
			t.Errorf("formatTurns(%v, %d) = %q, want %q", tt.turns, tt.max, got, tt.expected)
		}
	}
}
