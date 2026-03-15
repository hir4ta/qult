package tui

import "charm.land/lipgloss/v2"

// Accent color — single color for the entire UI.
var accent = lipgloss.Color("#5fafaf") // muted teal

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

	selectedStyle = lipgloss.NewStyle().
			Reverse(true)

	statusCompleted = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#8a8"))

	statusInProgress = lipgloss.NewStyle().
				Foreground(accent)

	statusBlocked = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#c66"))

	statusNotStarted = dimStyle

	progressFull = lipgloss.NewStyle().
			Foreground(accent)

	progressEmpty = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#333"))
)

// Layout styles.
var (
	helpStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#555")).
			Padding(1, 0, 0, 0)

	headerStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(accent).
			Padding(0, 0, 1, 0)

	viewportBorder = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("#333")).
			Padding(0, 1)
)

// renderProgress builds an ASCII progress bar: ########------
func renderProgress(completed, total, width int) string {
	if total == 0 {
		return dimStyle.Render("--")
	}
	filled := width * completed / total
	if filled > width {
		filled = width
	}
	empty := width - filled

	bar := progressFull.Render(repeat('#', filled)) +
		progressEmpty.Render(repeat('-', empty))
	return bar
}

func repeat(ch rune, n int) string {
	if n <= 0 {
		return ""
	}
	b := make([]rune, n)
	for i := range b {
		b[i] = ch
	}
	return string(b)
}

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
		return statusNotStarted.Render(status)
	}
}
