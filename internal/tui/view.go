package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// Layout:
//   Title + Stats + Score
//   ─── Feedback ─────────
//   ⚠ [pattern] observation
//     → suggestion
//   ─── Tasks ────────────
//   ✔ task1
//   ▶ task2
//   ─── Monitor ──────────
//   messages...
//   ───────────────────────
//   q: quit | ↑↓: select | Enter: expand | ?: help

func (m Model) View() string {
	if !m.ready {
		return "Waiting for session data..."
	}

	if m.showHelp {
		return m.renderHelpOverlay()
	}

	var sections []string

	// Title area (always shown)
	sections = append(sections, m.renderHeader())

	// Activity view (single tab)
	sections = append(sections, m.viewActivity())

	// Bottom
	sections = append(sections, m.renderSeparator())
	if m.sessionEnded {
		sections = append(sections, dimStyle.Render("  Session ended"))
	}
	sections = append(sections, m.renderHelp())

	return strings.Join(sections, "\n")
}

// viewActivity renders the Activity tab (original watch view).
func (m Model) viewActivity() string {
	var parts []string

	// Tasks section
	taskLines := m.renderTasks()
	if taskLines != "" {
		parts = append(parts, m.renderLabeledSeparator("Tasks"))
		parts = append(parts, taskLines)
	}

	// Monitor section (conversation history)
	parts = append(parts, m.renderLabeledSeparator("Monitor"))
	parts = append(parts, m.renderMessages())

	return strings.Join(parts, "\n")
}

func (m Model) renderHeader() string {
	title := headerStyle.Render(" claude-alfred watch ")

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
	scoreLine := m.renderScoreLine()
	return top + "\n" + statsStyle.Render(statsText) + "\n" + scoreLine
}

func (m Model) renderScoreLine() string {
	tpt := m.stats.ToolsPerTurn()
	top := m.stats.TopTools(3)
	var topParts []string
	for _, t := range top {
		topParts = append(topParts, fmt.Sprintf("%s:%d", t.Name, t.Count))
	}
	text := fmt.Sprintf("%.1f tools/turn", tpt)
	if len(topParts) > 0 {
		text += " | " + strings.Join(topParts, " ")
	}
	return dimStyle.Render(text)
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

func (m Model) renderLabeledSeparator(label string) string {
	w := m.width
	if w < 40 {
		w = 40
	}
	prefix := "\u2500\u2500\u2500 " + label + " "
	prefixWidth := lipgloss.Width(prefix)
	remaining := w - prefixWidth
	if remaining < 1 {
		remaining = 1
	}
	line := prefix + strings.Repeat("\u2500", remaining)
	return sectionSepStyle.Render(line)
}

func (m Model) renderSeparator() string {
	line := strings.Repeat("\u2500", max(m.width, 40))
	return separatorStyle.Render(line)
}

func (m Model) renderHelp() string {
	return helpStyle.Render("  q: quit | \u2191\u2193: select | Enter: expand/collapse | ?: help")
}


func (m Model) renderHelpOverlay() string {
	title := headerStyle.Render(" claude-alfred help ")

	keys := []struct{ key, desc string }{
		{"\u2191 / k", "Move cursor up"},
		{"\u2193 / j", "Move cursor down"},
		{"Enter", "Expand / collapse event detail"},
		{"g", "Jump to first event"},
		{"G", "Jump to latest event"},
		{"?", "Toggle this help"},
		{"q / Ctrl+C", "Quit"},
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
