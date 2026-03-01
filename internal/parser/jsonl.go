package parser

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const maxInputSummaryLen = 80

// ParseLine parses a single JSONL line and returns zero or more SessionEvents.
// Lines that are not user/assistant messages (e.g. progress, summary) return nil.
func ParseLine(line []byte) ([]SessionEvent, error) {
	if len(line) == 0 {
		return nil, nil
	}

	var raw RawMessage
	if err := json.Unmarshal(line, &raw); err != nil {
		return nil, fmt.Errorf("unmarshal raw message: %w", err)
	}

	ts := parseTimestamp(raw.Timestamp)

	switch raw.Type {
	case "user":
		return parseUserMessage(raw, ts)
	case "assistant":
		return parseAssistantMessage(raw.Message, ts)
	case "summary":
		return parseSummaryMessage(raw, ts), nil
	default:
		return nil, nil
	}
}

func parseSummaryMessage(raw RawMessage, ts time.Time) []SessionEvent {
	if raw.Summary == "" {
		return nil
	}
	if ts.IsZero() {
		ts = time.Now()
	}
	return []SessionEvent{{
		Type:          EventCompactBoundary,
		Timestamp:     ts,
		AssistantText: raw.Summary,
	}}
}

// ParsedLine holds parsed events together with raw metadata for store sync.
type ParsedLine struct {
	Events  []SessionEvent
	RawType string // JSONL "type" field value
	UUID    string // JSONL "uuid" field value
	RawJSON string // original JSON line (user/assistant only)
	ByteLen int    // byte length of the original line
}

// ParseLineRaw parses a JSONL line and returns events plus raw metadata.
func ParseLineRaw(line string) ParsedLine {
	pl := ParsedLine{
		ByteLen: len(line),
	}

	b := []byte(line)
	if len(b) == 0 {
		return pl
	}

	// Minimal unmarshal to extract type and uuid
	var raw RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return pl
	}
	pl.RawType = raw.Type
	pl.UUID = raw.UUID

	// Keep original JSON for user/assistant messages only
	if raw.Type == "user" || raw.Type == "assistant" {
		pl.RawJSON = line
	}

	events, _ := ParseLine(b)
	pl.Events = events
	return pl
}

func parseUserMessage(raw RawMessage, ts time.Time) ([]SessionEvent, error) {
	if raw.Message == nil {
		return nil, nil
	}

	var chat ChatMessage
	if err := json.Unmarshal(raw.Message, &chat); err != nil {
		return nil, fmt.Errorf("unmarshal chat message: %w", err)
	}

	// content can be a string or an array.
	text := extractUserText(chat.Content)
	if text != "" {
		return []SessionEvent{{
			Type:      EventUserMessage,
			Timestamp: ts,
			UserText:  text,
		}}, nil
	}

	// Check for tool_result content (AskUserQuestion answers, plan approvals, etc.)
	return parseToolResults(raw, chat.Content, ts)
}

func parseAssistantMessage(msgRaw json.RawMessage, ts time.Time) ([]SessionEvent, error) {
	if msgRaw == nil {
		return nil, nil
	}

	var chat ChatMessage
	if err := json.Unmarshal(msgRaw, &chat); err != nil {
		return nil, fmt.Errorf("unmarshal chat message: %w", err)
	}

	// Assistant content is always an array of ContentItems.
	var items []ContentItem
	if err := json.Unmarshal(chat.Content, &items); err != nil {
		// Might be a string in rare cases
		var s string
		if err2 := json.Unmarshal(chat.Content, &s); err2 == nil && s != "" {
			return []SessionEvent{{
				Type:          EventAssistantText,
				Timestamp:     ts,
				AssistantText: s,
			}}, nil
		}
		return nil, nil
	}

	var events []SessionEvent
	for _, item := range items {
		switch item.Type {
		case "text":
			if item.Text != "" {
				events = append(events, SessionEvent{
					Type:          EventAssistantText,
					Timestamp:     ts,
					AssistantText: item.Text,
				})
			}
		case "tool_use":
			ev := parseToolUse(item, ts)
			events = append(events, ev)
		}
		// "thinking", "tool_result" etc. are skipped
	}

	return events, nil
}

// parseToolUse routes tool_use items to specialized event types.
func parseToolUse(item ContentItem, ts time.Time) SessionEvent {
	switch item.Name {
	case "TaskCreate":
		return parseTaskCreate(item, ts)
	case "TaskUpdate":
		return parseTaskUpdate(item, ts)
	case "Task":
		return parseAgentSpawn(item, ts)
	case "SendMessage":
		return parseSendMessage(item, ts)
	default:
		return SessionEvent{
			Type:      EventToolUse,
			Timestamp: ts,
			ToolName:  item.Name,
			ToolInput: extractToolSummary(item.Name, item.Input),
		}
	}
}

func parseTaskCreate(item ContentItem, ts time.Time) SessionEvent {
	var ti TaskInput
	if item.Input != nil {
		_ = json.Unmarshal(item.Input, &ti)
	}
	return SessionEvent{
		Type:           EventTaskCreate,
		Timestamp:      ts,
		TaskSubject:    ti.Subject,
		TaskActiveForm: ti.ActiveForm,
		TaskStatus:     "pending",
	}
}

func parseTaskUpdate(item ContentItem, ts time.Time) SessionEvent {
	var ti TaskInput
	if item.Input != nil {
		_ = json.Unmarshal(item.Input, &ti)
	}
	return SessionEvent{
		Type:           EventTaskUpdate,
		Timestamp:      ts,
		TaskID:         ti.TaskID,
		TaskStatus:     ti.Status,
		TaskSubject:    ti.Subject,
		TaskActiveForm: ti.ActiveForm,
	}
}

func parseAgentSpawn(item ContentItem, ts time.Time) SessionEvent {
	var ai AgentInput
	if item.Input != nil {
		_ = json.Unmarshal(item.Input, &ai)
	}
	return SessionEvent{
		Type:      EventAgentSpawn,
		Timestamp: ts,
		AgentName: ai.Name,
		AgentType: ai.SubagentType,
		AgentDesc: Truncate(ai.Description, maxInputSummaryLen),
	}
}

func parseSendMessage(item ContentItem, ts time.Time) SessionEvent {
	var mi MessageInput
	if item.Input != nil {
		_ = json.Unmarshal(item.Input, &mi)
	}
	return SessionEvent{
		Type:         EventSendMessage,
		Timestamp:    ts,
		MsgType:      mi.Type,
		MsgRecipient: mi.Recipient,
		MsgSummary:   Truncate(mi.Summary, maxInputSummaryLen),
	}
}

// parseToolResults handles tool_result content items in user messages.
// This covers AskUserQuestion answers and ExitPlanMode plan approvals.
func parseToolResults(raw RawMessage, contentRaw json.RawMessage, ts time.Time) ([]SessionEvent, error) {
	// Check top-level toolUseResult for plan approval
	if raw.ToolUseResult != nil {
		var tur struct {
			Plan string `json:"plan"`
		}
		if err := json.Unmarshal(raw.ToolUseResult, &tur); err == nil && tur.Plan != "" {
			title := extractPlanTitle(tur.Plan)
			return []SessionEvent{{
				Type:      EventPlanApproval,
				Timestamp: ts,
				PlanTitle: title,
				PlanText:  tur.Plan,
			}}, nil
		}
	}

	// Parse content array for tool_result items
	var items []ContentItem
	if err := json.Unmarshal(contentRaw, &items); err != nil {
		return nil, nil
	}

	var events []SessionEvent
	for _, item := range items {
		if item.Type != "tool_result" || item.Content == nil {
			continue
		}
		// Extract string content from tool_result
		var s string
		if err := json.Unmarshal(item.Content, &s); err != nil {
			continue
		}

		// Parse TaskList output — extract task statuses from tool_result text
		if taskEvents := parseTaskListOutput(s, ts); len(taskEvents) > 0 {
			events = append(events, taskEvents...)
			continue
		}

		// AskUserQuestion answer
		if strings.HasPrefix(s, "User has answered") {
			answer := s
			// Extract just the Q&A part before the boilerplate
			if idx := strings.Index(answer, ". You can now"); idx > 0 {
				answer = answer[:idx]
			}
			answer = strings.TrimPrefix(answer, "User has answered your questions: ")
			return []SessionEvent{{
				Type:      EventUserMessage,
				Timestamp: ts,
				UserText:  answer,
				IsAnswer:  true,
			}}, nil
		}
		// AskUserQuestion rejected by user
		if strings.HasPrefix(s, "The user doesn't want to proceed") {
			return []SessionEvent{{
				Type:      EventUserMessage,
				Timestamp: ts,
				UserText:  "(rejected)",
				IsAnswer:  true,
			}}, nil
		}
	}

	if len(events) > 0 {
		return events, nil
	}
	return nil, nil
}

// taskListLineRe matches TaskList output lines: #ID [status] subject ...
var taskListLineRe = regexp.MustCompile(`#(\d+)\s+\[(completed|in_progress|pending)\]\s+(.+)`)

// taskListOwnerRe extracts trailing (owner) from the subject
var taskListOwnerRe = regexp.MustCompile(`\s+\(([^)]+)\)\s*$`)

// taskListBlockedRe strips [blocked by ...] from the subject
var taskListBlockedRe = regexp.MustCompile(`\s*\[blocked by[^\]]*\]\s*`)

// parseTaskListOutput extracts task status updates from TaskList tool_result text.
func parseTaskListOutput(s string, ts time.Time) []SessionEvent {
	lines := strings.Split(s, "\n")
	var events []SessionEvent
	for _, line := range lines {
		m := taskListLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		taskID := m[1]
		status := m[2]
		subject := m[3]

		// Strip [blocked by ...] from subject
		subject = taskListBlockedRe.ReplaceAllString(subject, "")

		// Strip trailing (owner)
		subject = taskListOwnerRe.ReplaceAllString(subject, "")
		subject = strings.TrimSpace(subject)

		events = append(events, SessionEvent{
			Type:        EventTaskUpdate,
			Timestamp:   ts,
			TaskID:      taskID,
			TaskStatus:  status,
			TaskSubject: subject,
		})
	}
	return events
}

// extractPlanTitle extracts the first markdown heading from plan text.
func extractPlanTitle(plan string) string {
	for _, line := range strings.Split(plan, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "# ") {
			return strings.TrimPrefix(line, "# ")
		}
	}
	return Truncate(plan, 40)
}

// extractUserText handles the polymorphic content field of user messages.
func extractUserText(raw json.RawMessage) string {
	// Try string first
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}

	// Try array — look for text content, skip tool_results
	var items []ContentItem
	if err := json.Unmarshal(raw, &items); err == nil {
		for _, item := range items {
			if item.Type == "text" && item.Text != "" {
				return item.Text
			}
		}
	}

	return ""
}

// extractToolSummary creates a short description of the tool use.
func extractToolSummary(toolName string, inputRaw json.RawMessage) string {
	if inputRaw == nil {
		return ""
	}

	var ti ToolInput
	if err := json.Unmarshal(inputRaw, &ti); err != nil {
		return ""
	}

	// Buddy MCP tools get dedicated summary extraction.
	if strings.Contains(toolName, "alfred_") {
		return extractAlfredToolSummary(toolName, ti)
	}

	var summary string
	switch toolName {
	case "Bash":
		summary = ti.Command
		if ti.Description != "" {
			summary = ti.Description
		}
	case "Read", "Write", "Edit":
		summary = ti.FilePath
	case "Grep":
		summary = ti.Pattern
		if ti.FilePath != "" {
			summary += " in " + ti.FilePath
		}
	case "Glob":
		summary = ti.Pattern
	case "ExitPlanMode":
		var pi struct {
			Plan string `json:"plan"`
		}
		if err := json.Unmarshal(inputRaw, &pi); err == nil && pi.Plan != "" {
			summary = extractPlanTitle(pi.Plan)
		}
	default:
		if ti.Description != "" {
			summary = ti.Description
		} else if ti.FilePath != "" {
			summary = ti.FilePath
		}
	}

	return Truncate(summary, maxInputSummaryLen)
}

// extractAlfredToolSummary builds a summary for alfred MCP tool calls.
func extractAlfredToolSummary(toolName string, ti ToolInput) string {
	// Query is the most informative field.
	if ti.Query != "" {
		return Truncate(fmt.Sprintf("%q", ti.Query), maxInputSummaryLen)
	}

	// Build from available fields.
	var parts []string
	if ti.Project != "" {
		parts = append(parts, "project:"+ti.Project)
	}
	if ti.SessionID != "" {
		sid := ti.SessionID
		if len(sid) > 8 {
			sid = sid[:8]
		}
		parts = append(parts, "session:"+sid)
	}
	if len(parts) > 0 {
		return Truncate(strings.Join(parts, " "), maxInputSummaryLen)
	}

	// Default label based on tool name.
	shortName := toolName
	if idx := strings.LastIndex(toolName, "alfred_"); idx >= 0 {
		shortName = toolName[idx:]
	}
	switch shortName {
	case "buddy_resume":
		return "latest session"
	case "buddy_sessions":
		return "recent"
	default:
		return "latest"
	}
}

func parseTimestamp(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		// Try unix ms (seen in some formats)
		return time.Time{}
	}
	return t.Local()
}

// Truncate shortens a string to maxLen runes, replacing newlines for single-line display.
func Truncate(s string, maxLen int) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "\n", " ")
	if len([]rune(s)) > maxLen {
		return string([]rune(s)[:maxLen-3]) + "..."
	}
	return s
}
