package parser

import (
	"encoding/json"
	"time"
)

// EventType represents the kind of parsed session event.
type EventType int

const (
	EventUserMessage EventType = iota
	EventAssistantText
	EventToolUse
	EventTaskCreate
	EventTaskUpdate
	EventAgentSpawn
	EventSendMessage
	EventPlanApproval       // plan approved via ExitPlanMode
	EventCompactBoundary    // context compaction summary
)

// SessionEvent is the simplified, parsed representation of a JSONL line
// that the TUI and analyzer consume.
type SessionEvent struct {
	Type      EventType
	Timestamp time.Time

	// EventUserMessage
	UserText string

	// EventAssistantText
	AssistantText string

	// EventToolUse
	ToolName  string
	ToolInput string // summary (description or command excerpt)

	// EventTaskCreate / EventTaskUpdate
	TaskID     string
	TaskSubject    string
	TaskStatus     string // "pending", "in_progress", "completed", "deleted"
	TaskActiveForm string

	// EventAgentSpawn
	AgentName string // team member name (if any)
	AgentType string // "Explore", "Plan", "general-purpose", etc.
	AgentDesc string // short description

	// EventSendMessage
	MsgRecipient string
	MsgSummary   string
	MsgType      string // "message", "broadcast", "shutdown_request", etc.

	// EventPlanApproval
	PlanTitle string
	PlanText  string

	// Display flags
	IsAnswer bool // true when this user message is an AskUserQuestion response
}

// RawMessage is the top-level JSON object in a JSONL line.
type RawMessage struct {
	Type           string          `json:"type"`
	UUID           string          `json:"uuid"`
	Timestamp      string          `json:"timestamp"`
	SessionID      string          `json:"sessionId"`
	TeamName       string          `json:"teamName,omitempty"`
	AgentID        string          `json:"agentId,omitempty"`
	IsSidechain    bool            `json:"isSidechain,omitempty"`
	Message        json.RawMessage `json:"message,omitempty"`
	Summary        string          `json:"summary,omitempty"`
	ParentUUID     *string         `json:"parentUuid,omitempty"`
	ToolUseResult  json.RawMessage `json:"toolUseResult,omitempty"`
}

// ChatMessage is the "message" field for user/assistant types.
type ChatMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	Model   string          `json:"model,omitempty"`
}

// ContentItem is an element inside the content array of a message.
type ContentItem struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	Name      string          `json:"name,omitempty"`
	ID        string          `json:"id,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`   // tool_result content (string or array)
	ToolUseID string          `json:"tool_use_id,omitempty"` // tool_result link
}

// ToolInput is a generic representation of tool_use input.
type ToolInput struct {
	Command     string `json:"command,omitempty"`
	Description string `json:"description,omitempty"`
	FilePath    string `json:"file_path,omitempty"`
	Pattern     string `json:"pattern,omitempty"`
}

// TaskInput is the input for TaskCreate/TaskUpdate tool calls.
type TaskInput struct {
	Subject     string `json:"subject,omitempty"`
	Description string `json:"description,omitempty"`
	ActiveForm  string `json:"activeForm,omitempty"`
	TaskID      string `json:"taskId,omitempty"`
	Status      string `json:"status,omitempty"`
	Owner       string `json:"owner,omitempty"`
}

// AgentInput is the input for Task (subagent spawn) tool calls.
type AgentInput struct {
	Description  string `json:"description,omitempty"`
	SubagentType string `json:"subagent_type,omitempty"`
	Name         string `json:"name,omitempty"`
	TeamName     string `json:"team_name,omitempty"`
	Model        string `json:"model,omitempty"`
}

// MessageInput is the input for SendMessage tool calls.
type MessageInput struct {
	Type      string `json:"type,omitempty"`
	Recipient string `json:"recipient,omitempty"`
	Content   string `json:"content,omitempty"`
	Summary   string `json:"summary,omitempty"`
}
