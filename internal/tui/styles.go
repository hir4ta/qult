package tui

import "charm.land/lipgloss/v2"

// Accent color — muted purple for the entire UI.
var accent = lipgloss.Color("#af87d7")

// Secondary accent for subtle highlights.
var accentDim = lipgloss.Color("#7a5fa0")

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

	sectionHeader = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#999"))

	blockerStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#c66"))

	scoreStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#8a8"))

	statusCompleted = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#8a8"))

	statusInProgress = lipgloss.NewStyle().
				Foreground(accent)

	statusBlocked = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#c66"))
)

// Layout styles.
var headerStyle = lipgloss.NewStyle().
	Bold(true).
	Foreground(accent)

// Content panel — subtle border around main content.
var contentPanelStyle = lipgloss.NewStyle().
	Border(lipgloss.RoundedBorder()).
	BorderForeground(lipgloss.Color("#333")).
	Padding(0, 1)

// Overlay (floating window) styles.
var (
	overlayStyle = lipgloss.NewStyle().
			Border(lipgloss.DoubleBorder()).
			BorderForeground(accent).
			Padding(1, 2)

	overlayTitleStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color("#fff")).
				Background(accentDim).
				Padding(0, 1)

	overlayDimBg = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#333"))

	breadcrumbStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#888"))

	breadcrumbActiveStyle = lipgloss.NewStyle().
				Foreground(accent).
				Bold(true)
)

// Checkbox markers.
const (
	checkDone   = "[x]"
	checkUndone = "[ ]"
)

// styledStatus returns a styled status string.
func styledStatus(status string) string {
	switch status {
	case "completed", "done", "implementation-complete":
		return statusCompleted.Render(status)
	case "in-progress", "active", "integration":
		return statusInProgress.Render(status)
	case "blocked":
		return statusBlocked.Render(status)
	default:
		return dimStyle.Render(status)
	}
}

// sourceStyle returns a styled source type tag.
func sourceStyle(source string) string {
	switch source {
	case "memory":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("#af87d7")).Render("mem")
	case "spec":
		return lipgloss.NewStyle().Foreground(accent).Render("spec")
	case "project":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("#d7af5f")).Render("proj")
	default:
		return dimStyle.Render(source)
	}
}
