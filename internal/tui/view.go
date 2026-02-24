package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/hir4ta/claude-buddy/internal/parser"
)

func (m Model) View() string {
	if !m.ready {
		return "Waiting for session data..."
	}

	if m.showHelp {
		return m.renderHelpOverlay()
	}

	var sections []string

	sections = append(sections, m.renderHeader())
	if len(m.tasks) > 0 {
		sections = append(sections, m.renderTasks())
	}
	sections = append(sections, m.renderSeparator())
	sections = append(sections, m.renderMessages())
	sections = append(sections, m.renderSeparator())
	if m.sessionEnded {
		sections = append(sections, dimStyle.Render("  Session ended"))
	}
	sections = append(sections, m.renderHelp())

	return strings.Join(sections, "\n")
}

func (m Model) renderHeader() string {
	title := headerStyle.Render(" claude-buddy watch ")

	// Pulsing activity indicator
	pulseChars := []string{"\u2022", "\u25e6"} // ● ◦
	pulse := pulseChars[m.animFrame/10%2]
	var pulseStyled string
	if m.animFrame/10%2 == 0 {
		pulseStyled = pulseActiveStyle.Render(pulse)
	} else {
		pulseStyled = pulseDimStyle.Render(pulse)
	}

	sessionInfo := fmt.Sprintf("Session: %s", truncateID(m.sessionID))

	statsText := fmt.Sprintf(
		"Turns: %d | Tools: %d (%.1f/turn) | %s",
		m.stats.TurnCount,
		m.stats.ToolUseCount,
		m.stats.ToolsPerTurn(),
		formatDuration(m.stats.Elapsed()),
	)

	top := lipgloss.JoinHorizontal(lipgloss.Top, title, " ", pulseStyled, " ", dimStyle.Render(sessionInfo))
	if m.inPlanMode {
		planBadge := planModeStyle.Render(" PLAN ")
		top = lipgloss.JoinHorizontal(lipgloss.Top, top, "  ", planBadge)
	}
	return top + "\n" + statsStyle.Render(statsText)
}

func (m Model) renderTasks() string {
	var lines []string
	for _, t := range m.tasks {
		switch t.Status {
		case "completed":
			icon := taskDoneStyle.Render("  \u2714")
			text := taskDoneStyle.Render(t.Subject)
			lines = append(lines, fmt.Sprintf("%s %s", icon, text))
		case "in_progress":
			displayText := t.Subject
			if t.ActiveForm != "" {
				displayText = t.ActiveForm
			}
			icon := taskActiveStyle.Render("  \u25b6")
			text := m.shimmerText(displayText)
			lines = append(lines, fmt.Sprintf("%s %s", icon, text))
		case "deleted":
			continue
		default: // pending
			icon := taskPendingStyle.Render("  \u25cb")
			text := taskPendingStyle.Render(t.Subject)
			lines = append(lines, fmt.Sprintf("%s %s", icon, text))
		}
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n")
}

// shimmerText renders text with a bright highlight that sweeps left to right.
func (m Model) shimmerText(text string) string {
	runes := []rune(text)
	textLen := len(runes)
	if textLen == 0 {
		return taskActiveStyle.Render(text)
	}

	// Shimmer window: 3 chars wide, sweeps across the text
	shimmerWidth := 3
	// Total cycle length includes the text + some padding for the gap
	cycleLen := textLen + 8
	shimmerPos := m.animFrame % cycleLen

	var result strings.Builder
	for i, r := range runes {
		dist := i - shimmerPos
		if dist >= 0 && dist < shimmerWidth {
			// In the shimmer highlight zone
			result.WriteString(shimmerHighStyle.Render(string(r)))
		} else if dist == -1 || dist == shimmerWidth {
			// Adjacent glow
			result.WriteString(shimmerGlowStyle.Render(string(r)))
		} else {
			result.WriteString(taskActiveStyle.Render(string(r)))
		}
	}
	return result.String()
}

func (m Model) renderSeparator() string {
	line := strings.Repeat("\u2500", max(m.width, 40))
	return separatorStyle.Render(line)
}

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


func (m Model) renderHelp() string {
	return helpStyle.Render("  q: quit | \u2191\u2193: select | Enter: expand/collapse | ?: help")
}

func (m Model) renderHelpOverlay() string {
	title := headerStyle.Render(" claude-buddy help ")

	keys := []struct{ key, desc string }{
		{"\u2191 / k", "Move cursor up"},
		{"\u2193 / j", "Move cursor down"},
		{"Enter", "Expand / collapse event detail"},
		{"g", "Jump to first event"},
		{"G", "Jump to latest event"},
		{"?", "Toggle this help"},
		{"q / Ctrl+C", "Quit"},
	}

	if m.lang.Code == "ja" {
		keys = []struct{ key, desc string }{
			{"\u2191 / k", "\u30ab\u30fc\u30bd\u30eb\u3092\u4e0a\u3078"},
			{"\u2193 / j", "\u30ab\u30fc\u30bd\u30eb\u3092\u4e0b\u3078"},
			{"Enter", "\u30a4\u30d9\u30f3\u30c8\u8a73\u7d30\u3092\u5c55\u958b / \u6298\u308a\u305f\u305f\u307f"},
			{"g", "\u5148\u982d\u3078\u30b8\u30e3\u30f3\u30d7"},
			{"G", "\u6700\u65b0\u3078\u30b8\u30e3\u30f3\u30d7"},
			{"?", "\u3053\u306e\u30d8\u30eb\u30d7\u3092\u8868\u793a / \u975e\u8868\u793a"},
			{"q / Ctrl+C", "\u7d42\u4e86"},
		}
	}

	var lines []string
	for _, k := range keys {
		keyStyled := lipgloss.NewStyle().
			Foreground(lipgloss.Color("#B5A06A")).
			Bold(true).
			Width(14).
			Render(k.key)
		lines = append(lines, "  "+keyStyled+dimStyle.Render(k.desc))
	}

	content := strings.Join(lines, "\n")
	footer := helpStyle.Render("  Press any key to close")

	return title + "\n\n" + content + "\n\n" + footer
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

func wrapText(s string, width int) []string {
	if width <= 0 {
		width = 80
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	var result []string
	for _, paragraph := range strings.Split(s, "\n") {
		if paragraph == "" {
			result = append(result, "")
			continue
		}
		words := strings.Fields(paragraph)
		if len(words) == 0 {
			result = append(result, "")
			continue
		}
		line := words[0]
		for _, w := range words[1:] {
			if lipgloss.Width(line)+1+lipgloss.Width(w) > width {
				// Flush current line, breaking it if it exceeds width
				result = append(result, breakLine(line, width)...)
				line = w
			} else {
				line += " " + w
			}
		}
		result = append(result, breakLine(line, width)...)
	}
	return result
}

// breakLine splits a single line into multiple lines if it exceeds width.
// Handles CJK characters that occupy 2 terminal columns per rune.
func breakLine(s string, width int) []string {
	if lipgloss.Width(s) <= width {
		return []string{s}
	}
	var lines []string
	runes := []rune(s)
	start := 0
	w := 0
	for i, r := range runes {
		rw := lipgloss.Width(string(r))
		if w+rw > width && i > start {
			lines = append(lines, string(runes[start:i]))
			start = i
			w = 0
		}
		w += rw
	}
	if start < len(runes) {
		lines = append(lines, string(runes[start:]))
	}
	return lines
}

func truncateID(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}

// formatDuration formats a duration as human-readable compact text.
// Examples: "3m", "1h08m", "2d5h", "1w3d"
func formatDuration(d time.Duration) string {
	if d < time.Minute {
		return "0m"
	}
	totalMin := int(d.Minutes())
	switch {
	case totalMin < 60:
		return fmt.Sprintf("%dm", totalMin)
	case totalMin < 60*24:
		h := totalMin / 60
		m := totalMin % 60
		if m == 0 {
			return fmt.Sprintf("%dh", h)
		}
		return fmt.Sprintf("%dh%02dm", h, m)
	case totalMin < 60*24*7:
		days := totalMin / (60 * 24)
		hours := (totalMin % (60 * 24)) / 60
		if hours == 0 {
			return fmt.Sprintf("%dd", days)
		}
		return fmt.Sprintf("%dd%dh", days, hours)
	default:
		weeks := totalMin / (60 * 24 * 7)
		days := (totalMin % (60 * 24 * 7)) / (60 * 24)
		if days == 0 {
			return fmt.Sprintf("%dw", weeks)
		}
		return fmt.Sprintf("%dw%dd", weeks, days)
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
