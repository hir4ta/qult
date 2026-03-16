package tui

import "charm.land/lipgloss/v2"

// Claude Code color palette — warm, muted tones inspired by Claude's brand.
var (
	// Primary accent — muted terracotta (Claude orange).
	accent = lipgloss.Color("#da7756")
	// Darker variant for overlay backgrounds.
	accentDim = lipgloss.Color("#8a4a35")

	// Secondary accent — dusty sage/teal (cool complement).
	secondary = lipgloss.Color("#7c9a92")

	// Tertiary — warm gold/amber for decisions and project context.
	tertiary = lipgloss.Color("#c49a5c")

	// Highlight — warm coral for shimmer and active items.
	highlight = lipgloss.Color("#e8976b")

	// Dusty rose — for pattern/info type items.
	dustyRose = lipgloss.Color("#b07878")

	// Neutrals — warm-tinted grays.
	warmDim    = lipgloss.Color("#7a7270")
	warmDimmer = lipgloss.Color("#5a5555")
	warmDark   = lipgloss.Color("#3a3535")
	warmLight  = lipgloss.Color("#a09595")
)

// Tab styles.
var (
	activeTabStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(accent).
			Underline(true).
			Padding(0, 2)

	inactiveTabStyle = lipgloss.NewStyle().
				Foreground(warmDim).
				Padding(0, 2)

	tabBarStyle = lipgloss.NewStyle().
			BorderBottom(true).
			BorderStyle(lipgloss.NormalBorder()).
			BorderForeground(warmDark)

	titleBarStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(accent)

	versionStyle = lipgloss.NewStyle().
			Foreground(warmDim)
)

// Content styles.
var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(accent)

	dimStyle = lipgloss.NewStyle().
			Foreground(warmDim)

	sectionHeader = lipgloss.NewStyle().
			Bold(true).
			Foreground(secondary)

	blockerStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#c66"))

	scoreStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#8a8"))

	statusCompleted = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#8a8"))

	statusInProgress = lipgloss.NewStyle().
				Foreground(highlight)

	statusBlocked = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#c66"))
)

// Content panel — subtle border around main content.
var contentPanelStyle = lipgloss.NewStyle().
	Border(lipgloss.RoundedBorder()).
	BorderForeground(warmDark).
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
			Foreground(warmDark)

	breadcrumbStyle = lipgloss.NewStyle().
			Foreground(warmLight)

	breadcrumbActiveStyle = lipgloss.NewStyle().
				Foreground(accent).
				Bold(true)
)

// Review round navigation style.
var reviewRoundStyle = lipgloss.NewStyle().
	Foreground(accent).
	Bold(true)

// Carried-over (unresolved) comment from previous rounds — dimmer coral.
var reviewCarriedStyle = lipgloss.NewStyle().
	Foreground(lipgloss.Color("#a07058"))

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
		return lipgloss.NewStyle().Foreground(highlight).Render("mem")
	case "spec":
		return lipgloss.NewStyle().Foreground(accent).Render("spec")
	case "project":
		return lipgloss.NewStyle().Foreground(tertiary).Render("proj")
	default:
		return dimStyle.Render(source)
	}
}

// Sub-type styles for knowledge maturity visualization.
var (
	subTypeRule     = lipgloss.NewStyle().Foreground(lipgloss.Color("#8a8")).Bold(true)
	subTypeDecision = lipgloss.NewStyle().Foreground(tertiary)
	subTypePattern  = lipgloss.NewStyle().Foreground(dustyRose)
	subTypeGeneral  = lipgloss.NewStyle().Foreground(warmDim)
	hitCountStyle   = lipgloss.NewStyle().Foreground(warmDimmer)
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
