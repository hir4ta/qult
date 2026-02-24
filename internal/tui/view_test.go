package tui

import (
	"testing"

	"github.com/hir4ta/claude-buddy/internal/parser"
)

func TestIsVisibleEvent(t *testing.T) {
	tests := []struct {
		name string
		ev   parser.SessionEvent
		want bool
	}{
		{
			name: "user message visible",
			ev:   parser.SessionEvent{Type: parser.EventUserMessage, UserText: "hello"},
			want: true,
		},
		{
			name: "assistant text visible",
			ev:   parser.SessionEvent{Type: parser.EventAssistantText, AssistantText: "response"},
			want: true,
		},
		{
			name: "tool use hidden",
			ev:   parser.SessionEvent{Type: parser.EventToolUse, ToolName: "Read", ToolInput: "/path"},
			want: false,
		},
		{
			name: "task create visible",
			ev:   parser.SessionEvent{Type: parser.EventTaskCreate, TaskSubject: "Fix bug"},
			want: true,
		},
		{
			name: "agent spawn visible",
			ev:   parser.SessionEvent{Type: parser.EventAgentSpawn, AgentType: "Explore"},
			want: true,
		},
		{
			name: "unknown type hidden (formatEvent returns empty)",
			ev:   parser.SessionEvent{Type: parser.EventCompactBoundary},
			want: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isVisibleEvent(tt.ev)
			if got != tt.want {
				t.Errorf("isVisibleEvent() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestCollectToolEvents(t *testing.T) {
	events := []parser.SessionEvent{
		{Type: parser.EventAssistantText, AssistantText: "I'll read the file"},
		{Type: parser.EventToolUse, ToolName: "Read", ToolInput: "/foo.go"},
		{Type: parser.EventToolUse, ToolName: "Edit", ToolInput: "/foo.go"},
		{Type: parser.EventUserMessage, UserText: "thanks"},
		{Type: parser.EventToolUse, ToolName: "Bash", ToolInput: "go test"},
	}

	// Collect tools after assistant at index 0
	tools := collectToolEvents(events, 0)
	if len(tools) != 2 {
		t.Fatalf("expected 2 tools, got %d", len(tools))
	}
	if tools[0].ToolName != "Read" {
		t.Errorf("tools[0] = %s, want Read", tools[0].ToolName)
	}
	if tools[1].ToolName != "Edit" {
		t.Errorf("tools[1] = %s, want Edit", tools[1].ToolName)
	}

	// Collect tools after user message at index 3 — should get none (Bash is tool but not preceded by assistant)
	tools2 := collectToolEvents(events, 3)
	if len(tools2) != 1 {
		t.Fatalf("expected 1 tool after index 3, got %d", len(tools2))
	}

	// Collect tools after last event — should be empty
	tools3 := collectToolEvents(events, 4)
	if len(tools3) != 0 {
		t.Fatalf("expected 0 tools after last index, got %d", len(tools3))
	}
}

func TestFormatToolSummary(t *testing.T) {
	tests := []struct {
		name    string
		ev      parser.SessionEvent
		wantLen bool // true if non-empty
	}{
		{
			name:    "Read tool",
			ev:      parser.SessionEvent{Type: parser.EventToolUse, ToolName: "Read", ToolInput: "/path/to/file.go"},
			wantLen: true,
		},
		{
			name:    "Bash tool",
			ev:      parser.SessionEvent{Type: parser.EventToolUse, ToolName: "Bash", ToolInput: "go test ./..."},
			wantLen: true,
		},
		{
			name:    "TaskList hidden",
			ev:      parser.SessionEvent{Type: parser.EventToolUse, ToolName: "TaskList"},
			wantLen: false,
		},
		{
			name:    "TaskGet hidden",
			ev:      parser.SessionEvent{Type: parser.EventToolUse, ToolName: "TaskGet"},
			wantLen: false,
		},
		{
			name:    "TaskStop hidden",
			ev:      parser.SessionEvent{Type: parser.EventToolUse, ToolName: "TaskStop"},
			wantLen: false,
		},
		{
			name:    "non-tool event",
			ev:      parser.SessionEvent{Type: parser.EventUserMessage, UserText: "hello"},
			wantLen: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := formatToolSummary(tt.ev)
			if tt.wantLen && got == "" {
				t.Error("expected non-empty summary, got empty")
			}
			if !tt.wantLen && got != "" {
				t.Errorf("expected empty summary, got %q", got)
			}
		})
	}
}
