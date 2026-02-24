package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/hir4ta/claude-buddy/internal/analyzer"
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
	if len(m.alerts) > 0 {
		sections = append(sections, m.renderAlerts())
	}
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

func (m Model) renderAlerts() string {
	var lines []string
	for _, a := range m.alerts {
		patternName := analyzer.PatternName(a.Pattern)

		contentWidth := m.width - 4
		if contentWidth < 40 {
			contentWidth = 40
		}

		style := alertWarningStyle
		if a.Level >= analyzer.LevelAction {
			style = alertActionStyle
		}

		// First line: icon + pattern name + observation
		firstLine := fmt.Sprintf(" \u26a0 [%s] %s", patternName, a.Observation)
		// Continuation: suggestion prefixed with arrow
		contLine := fmt.Sprintf("   \u2192 %s ", a.Suggestion)

		for _, text := range []string{firstLine, contLine} {
			wrapped := wrapText(text, contentWidth)
			for _, wl := range wrapped {
				// Pad to contentWidth so the background color fills the full width
				pad := contentWidth - lipgloss.Width(wl)
				if pad > 0 {
					wl += strings.Repeat(" ", pad)
				}
				lines = append(lines, "  "+style.Render(wl))
			}
		}
	}
	return strings.Join(lines, "\n")
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

	shimmerWidth := 3
	cycleLen := textLen + 8
	shimmerPos := m.animFrame % cycleLen

	var result strings.Builder
	for i, r := range runes {
		dist := i - shimmerPos
		if dist >= 0 && dist < shimmerWidth {
			result.WriteString(shimmerHighStyle.Render(string(r)))
		} else if dist == -1 || dist == shimmerWidth {
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
