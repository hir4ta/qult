package tui

import (
	"fmt"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/parser"
)

// viewLine is a single rendered line in the message area.
type viewLine struct {
	text       string
	isCursor   bool
	isExpanded bool // this line is expanded content (inside the box)
}

func (m Model) renderMessages() string {
	if len(m.events) == 0 {
		return dimStyle.Render("  Waiting for messages...")
	}

	borderOverhead := 4
	contentWidth := m.width - 6 - borderOverhead
	if contentWidth < 30 {
		contentWidth = 30
	}

	var lines []viewLine
	for i, ev := range m.events {
		if !isVisibleEvent(ev) {
			continue
		}
		line := formatEvent(ev)
		if line == "" {
			continue
		}
		isCursor := i == m.cursorIdx
		lines = append(lines, viewLine{text: line, isCursor: isCursor})

		if m.expanded[i] {
			fullText := eventFullText(ev)
			if fullText != "" {
				rendered := renderMarkdown(fullText, contentWidth)
				startIdx := 0
				if i == m.cursorIdx && m.expandOffset > 0 {
					startIdx = m.expandOffset
					if startIdx > len(rendered) {
						startIdx = len(rendered)
					}
				}
				for _, rl := range rendered[startIdx:] {
					lines = append(lines, viewLine{
						text:       rl,
						isExpanded: true,
					})
				}
			}

			// Show tool events under expanded assistant
			if ev.Type == parser.EventAssistantText {
				tools := collectToolEvents(m.events, i)
				for _, tev := range tools {
					summary := formatToolSummary(tev)
					if summary != "" {
						lines = append(lines, viewLine{
							text:       summary,
							isExpanded: true,
						})
					}
				}
			}
		}
	}

	if len(lines) == 0 {
		return dimStyle.Render("  Waiting for messages...")
	}

	availableLines := m.msgAreaHeight()

	cursorLine := 0
	for i, l := range lines {
		if l.isCursor {
			cursorLine = i
			break
		}
	}

	var start int
	windowLines := availableLines
	if m.expanded[m.cursorIdx] {
		start = cursorLine
		windowLines = availableLines - 2 // reserve 2 lines for expanded box border (top + bottom)
		if windowLines < 3 {
			windowLines = 3
		}
	} else {
		start = cursorLine - availableLines/2
	}
	if start < 0 {
		start = 0
	}
	end := start + windowLines
	if end > len(lines) {
		end = len(lines)
		start = end - windowLines
		if start < 0 {
			start = 0
		}
	}

	var result []string
	visible := lines[start:end]
	i := 0
	for i < len(visible) {
		l := visible[i]

		if l.isExpanded {
			var block []string
			for i < len(visible) && visible[i].isExpanded {
				block = append(block, visible[i].text)
				i++
			}
			boxContent := strings.Join(block, "\n")
			box := expandedBoxStyle.Width(contentWidth + 2).Render(boxContent)
			for _, boxLine := range strings.Split(box, "\n") {
				result = append(result, "      "+boxLine)
			}
			continue
		}

		text := l.text
		if l.isCursor && len(text) >= 2 && text[:2] == "  " {
			text = cursorStyle.Render("\u25b6") + " " + text[2:]
		}
		result = append(result, text)
		i++
	}

	return strings.Join(result, "\n")
}

func formatTimestamp(ev parser.SessionEvent) string {
	if ev.Timestamp.IsZero() {
		return ""
	}
	return dimStyle.Render(ev.Timestamp.Format("2006-01-02 15:04")) + " "
}

// alignLabel right-aligns a styled label within [assistant] width (11 chars).
func alignLabel(styled string, rawLen int) string {
	const maxLabelLen = 11 // len("[assistant]")
	if rawLen >= maxLabelLen {
		return styled
	}
	return strings.Repeat(" ", maxLabelLen-rawLen) + styled
}

func formatEvent(ev parser.SessionEvent) string {
	ts := formatTimestamp(ev)

	switch ev.Type {
	case parser.EventUserMessage:
		var label string
		if ev.IsAnswer {
			label = alignLabel(answerStyle.Render("[answer]"), 8)
		} else {
			label = alignLabel(userMsgStyle.Render("[user]"), 6)
		}
		text := parser.Truncate(ev.UserText, 60)
		return fmt.Sprintf("  %s%s %s", ts, label, text)

	case parser.EventToolUse:
		// Internal task coordination tools — their info is shown via task events instead
		switch ev.ToolName {
		case "TaskList", "TaskGet", "TaskStop":
			return ""
		}
		// buddy MCP tools shown as [tip]
		if isBuddyTool(ev.ToolName) {
			label := alignLabel(tipLabelStyle.Render("[tip]"), 5)
			// Extract short tool name: "mcp__claude-buddy__buddy_tips" -> "buddy_tips"
			shortName := ev.ToolName
			if idx := strings.LastIndex(shortName, "buddy_"); idx >= 0 {
				shortName = shortName[idx:]
			}
			name := tipLabelStyle.Render(shortName)
			input := tipTextStyle.Render(parser.Truncate(ev.ToolInput, 45))
			return fmt.Sprintf("  %s%s %s %s", ts, label, name, input)
		}
		label := alignLabel(toolUseStyle.Render("[tool]"), 6)
		name := toolNameStyle.Render(ev.ToolName)
		input := dimStyle.Render(parser.Truncate(ev.ToolInput, 45))
		return fmt.Sprintf("  %s%s %s \u2192 %s", ts, label, name, input)

	case parser.EventAssistantText:
		label := alignLabel(assistantTextStyle.Render("[assistant]"), 11)
		text := dimStyle.Render(parser.Truncate(ev.AssistantText, 55))
		return fmt.Sprintf("  %s%s %s", ts, label, text)

	case parser.EventTaskCreate:
		label := alignLabel(taskActiveStyle.Render("[task+]"), 7)
		text := parser.Truncate(ev.TaskSubject, 55)
		return fmt.Sprintf("  %s%s %s", ts, label, text)

	case parser.EventTaskUpdate:
		icon := "\u2022"
		style := taskPendingStyle
		switch ev.TaskStatus {
		case "in_progress":
			icon = "\u25b6"
			style = taskActiveStyle
		case "completed":
			icon = "\u2714"
			style = taskDoneStyle
		}
		raw := fmt.Sprintf("[task %s]", icon)
		label := alignLabel(style.Render(raw), len([]rune(raw)))
		text := ev.TaskID
		if ev.TaskActiveForm != "" {
			text += " " + ev.TaskActiveForm
		} else if ev.TaskSubject != "" {
			text += " " + ev.TaskSubject
		}
		return fmt.Sprintf("  %s%s %s", ts, label, style.Render(parser.Truncate(text, 55)))

	case parser.EventAgentSpawn:
		label := alignLabel(agentStyle.Render("[agent]"), 7)
		name := ev.AgentType
		if ev.AgentName != "" {
			name = ev.AgentName + " (" + ev.AgentType + ")"
		}
		desc := dimStyle.Render(parser.Truncate(ev.AgentDesc, 40))
		return fmt.Sprintf("  %s%s %s \u2192 %s", ts, label, agentStyle.Render(name), desc)

	case parser.EventSendMessage:
		label := alignLabel(messageStyle.Render("[msg]"), 5)
		target := ev.MsgRecipient
		if ev.MsgType == "broadcast" {
			target = "ALL"
		}
		summary := dimStyle.Render(parser.Truncate(ev.MsgSummary, 45))
		return fmt.Sprintf("  %s%s \u2192 %s: %s", ts, label, messageStyle.Render(target), summary)

	case parser.EventPlanApproval:
		label := alignLabel(taskActiveStyle.Render("[plan]"), 6)
		title := parser.Truncate(ev.PlanTitle, 55)
		return fmt.Sprintf("  %s%s %s", ts, label, title)

	default:
		return ""
	}
}

func eventFullText(ev parser.SessionEvent) string {
	switch ev.Type {
	case parser.EventUserMessage:
		return ev.UserText
	case parser.EventAssistantText:
		return ev.AssistantText
	case parser.EventToolUse:
		return ev.ToolInput
	case parser.EventPlanApproval:
		return ev.PlanText
	default:
		return ""
	}
}

// isBuddyTool returns true if the tool name is a claude-buddy MCP tool.
func isBuddyTool(name string) bool {
	return strings.Contains(name, "buddy_")
}

// isVisibleEvent returns true if the event should appear as a row in the event list.
// Tool-use events are hidden from the list except for buddy MCP tools ([tip]).
func isVisibleEvent(ev parser.SessionEvent) bool {
	if ev.Type == parser.EventToolUse {
		return isBuddyTool(ev.ToolName)
	}
	return formatEvent(ev) != ""
}

// collectToolEvents returns consecutive tool-use events that follow assistantIdx.
func collectToolEvents(events []parser.SessionEvent, assistantIdx int) []parser.SessionEvent {
	var tools []parser.SessionEvent
	for i := assistantIdx + 1; i < len(events); i++ {
		if events[i].Type == parser.EventToolUse {
			tools = append(tools, events[i])
		} else {
			break
		}
	}
	return tools
}

// formatToolSummary returns a one-line summary of a tool event for the expanded view.
// Returns "" for internal task coordination tools.
func formatToolSummary(ev parser.SessionEvent) string {
	if ev.Type != parser.EventToolUse {
		return ""
	}
	switch ev.ToolName {
	case "TaskList", "TaskGet", "TaskStop":
		return ""
	}
	name := toolSummaryStyle.Render(ev.ToolName)
	input := toolSummaryDimStyle.Render(parser.Truncate(ev.ToolInput, 60))
	return fmt.Sprintf("  %s %s \u2192 %s", nfWrench, name, input)
}
