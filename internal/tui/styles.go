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

// Review round navigation style.
var reviewRoundStyle = lipgloss.NewStyle().
	Foreground(accent).
	Bold(true)

// Carried-over (unresolved) comment from previous rounds — dimmer orange.
var reviewCarriedStyle = lipgloss.NewStyle().
	Foreground(lipgloss.Color("#a07040"))

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

// Sub-type styles for knowledge maturity visualization.
var (
	subTypeRule     = lipgloss.NewStyle().Foreground(lipgloss.Color("#8a8")).Bold(true)
	subTypeDecision = lipgloss.NewStyle().Foreground(lipgloss.Color("#d7af5f"))
	subTypePattern  = lipgloss.NewStyle().Foreground(lipgloss.Color("#87afd7"))
	subTypeGeneral  = lipgloss.NewStyle().Foreground(lipgloss.Color("#666"))
	hitCountStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("#555"))
)

// styledKnowledgeStatus returns a styled status badge for structured knowledge.
func styledKnowledgeStatus(status string) string {
	switch status {
	case "approved":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("#8a8")).Render("[approved]")
	case "rejected":
		return lipgloss.NewStyle().Foreground(lipgloss.Color("#c66")).Render("[rejected]")
	default:
		return ""
	}
}

// styledSubType returns a styled sub_type abbreviation.
func styledSubType(subType string) string {
	switch subType {
	case "rule":
		return subTypeRule.Render("rule")
	case "decision":
		return subTypeDecision.Render("dec")
	case "pattern":
		return subTypePattern.Render("pat")
	case "general":
		return subTypeGeneral.Render("gen")
	default:
		return ""
	}
}
