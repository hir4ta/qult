package tui

import "charm.land/lipgloss/v2"

// Accent color — single muted teal for the entire UI.
var accent = lipgloss.Color("#5fafaf")

// Tab styles.
var (
	activeTabStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(accent).
			Underline(true).
			Padding(0, 2)

	inactiveTabStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#666")).
				Padding(0, 2)

	tabBarStyle = lipgloss.NewStyle().
			BorderBottom(true).
			BorderStyle(lipgloss.NormalBorder()).
			BorderForeground(lipgloss.Color("#333"))
)

// Content styles.
var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(accent)

	dimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#666"))

	statusCompleted = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#8a8"))

	statusInProgress = lipgloss.NewStyle().
				Foreground(accent)

	statusBlocked = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#c66"))
)

// Layout styles.
var (
	headerStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(accent)
)

// styledStatus returns a styled status string.
func styledStatus(status string) string {
	switch status {
	case "completed", "done":
		return statusCompleted.Render(status)
	case "in-progress", "active":
		return statusInProgress.Render(status)
	case "blocked":
		return statusBlocked.Render(status)
	default:
		return dimStyle.Render(status)
	}
}
