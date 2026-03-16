package tui

import "charm.land/lipgloss/v2"

// Color palette — Everforest / Gruvbox inspired.
// 7 accent colors, each with a single clear role.
//
//	aqua    #7fbbb3  — navigation: tabs, overlay border, breadcrumb
//	orange  #e69875  — content titles, warmth, shimmer
//	gold    #dbbc7f  — section headers, review comments
//	green   #a7c080  — success, completion, rules
//	red     #e67e80  — errors, blockers
//	purple  #d699b6  — memory, subtle info
//	blue    #7393b3  — in-progress, pattern, project
//	gray    #859289  — inactive, dim
var (
	aqua   = lipgloss.Color("#7fbbb3")
	orange = lipgloss.Color("#e69875")
	gold   = lipgloss.Color("#dbbc7f")
	green  = lipgloss.Color("#a7c080")
	red    = lipgloss.Color("#e67e80")
	purple = lipgloss.Color("#d699b6")
	blue   = lipgloss.Color("#7393b3")

	gray     = lipgloss.Color("#859289")
	darkGray = lipgloss.Color("#4a4940")
	fgWarm   = lipgloss.Color("#d3c6aa")
)

// ── Navigation layer (aqua) ─────────────────────────────────────────

var (
	activeTabStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(aqua).
			Underline(true).
			Padding(0, 2)

	inactiveTabStyle = lipgloss.NewStyle().
				Foreground(gray).
				Padding(0, 2)

	tabBarStyle = lipgloss.NewStyle().
			BorderBottom(true).
			BorderStyle(lipgloss.NormalBorder()).
			BorderForeground(darkGray)

	titleBarStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(aqua)

	versionStyle = lipgloss.NewStyle().
			Foreground(gray)
)

// ── Content layer ───────────────────────────────────────────────────

var (
	// Content titles — orange (warm, prominent).
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(orange)

	// Section headers — gold (secondary emphasis, distinct from title).
	sectionHeader = lipgloss.NewStyle().
			Bold(true).
			Foreground(gold)

	dimStyle = lipgloss.NewStyle().
			Foreground(gray)

	blockerStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(red)

	scoreStyle = lipgloss.NewStyle().
			Foreground(green)
)

// ── Status (each state = unique color) ──────────────────────────────

var (
	statusCompleted = lipgloss.NewStyle().
			Foreground(green)

	statusInProgress = lipgloss.NewStyle().
				Foreground(blue)

	statusBlocked = lipgloss.NewStyle().
			Foreground(red)
)

// ── Panels ──────────────────────────────────────────────────────────

var contentPanelStyle = lipgloss.NewStyle().
	Border(lipgloss.RoundedBorder()).
	BorderForeground(darkGray).
	Padding(0, 1)

// ── Overlay (floating window) ───────────────────────────────────────

var (
	overlayStyle = lipgloss.NewStyle().
			Border(lipgloss.DoubleBorder()).
			BorderForeground(aqua).
			Padding(1, 2)

	overlayTitleStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(fgWarm).
				Background(lipgloss.Color("#3a5a58")).
				Padding(0, 1)

	overlayDimBg = lipgloss.NewStyle().
			Foreground(darkGray)

	// breadcrumbStyle/breadcrumbActiveStyle removed — overlay no longer uses breadcrumbs.
)

// ── Review ──────────────────────────────────────────────────────────

var reviewRoundStyle = lipgloss.NewStyle().
	Foreground(aqua).
	Bold(true)

// Carried-over (unresolved) comments — dimmed gold.
var reviewCarriedStyle = lipgloss.NewStyle().
	Foreground(lipgloss.Color("#9a8a60"))

// ── Checkbox ────────────────────────────────────────────────────────

const (
	checkDone   = "[x]"
	checkUndone = "[ ]"
)

// ── Status formatting ───────────────────────────────────────────────

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

// ── Source tags (each source = unique color) ─────────────────────────

func sourceStyle(source string) string {
	switch source {
	case "memory":
		return lipgloss.NewStyle().Foreground(purple).Render("mem")
	case "spec":
		return lipgloss.NewStyle().Foreground(aqua).Render("spec")
	case "project":
		return lipgloss.NewStyle().Foreground(blue).Render("proj")
	default:
		return dimStyle.Render(source)
	}
}

// ── Knowledge sub-types (each type = unique color) ──────────────────

var (
	subTypeRule     = lipgloss.NewStyle().Foreground(green).Bold(true)
	subTypeDecision = lipgloss.NewStyle().Foreground(orange)
	subTypePattern  = lipgloss.NewStyle().Foreground(aqua)
	subTypeGeneral  = lipgloss.NewStyle().Foreground(gray)
	hitCountStyle   = lipgloss.NewStyle().Foreground(darkGray)
)

func styledKnowledgeStatus(status string) string {
	switch status {
	case "approved":
		return lipgloss.NewStyle().Foreground(green).Render("[approved]")
	case "rejected":
		return lipgloss.NewStyle().Foreground(red).Render("[rejected]")
	default:
		return ""
	}
}

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
