package tui

import "github.com/charmbracelet/lipgloss"

var (
	// Header area
	headerStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#D0D0D0")).
			Background(lipgloss.Color("#C15F3C")).
			Padding(0, 1)

	statsStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#B0A8B8"))

	// Message stream
	userMsgStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#6A9FB5")).
			Bold(true)

	toolUseStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#B5A06A"))

	toolNameStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#B5A06A")).
			Bold(true)

	assistantTextStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#C0B8C0"))

	// Task progress
	taskPendingStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#908890"))

	taskActiveStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#B5A06A")).
			Bold(true)

	taskDoneStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#6A9A78"))

	// Agent/team
	agentStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#A0708A"))

	messageStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#7090A0"))

	// Tip label (alfred MCP tool events)
	tipLabelStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#6A9A78")).
			Bold(true)

	tipTextStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#6A9A78"))

	// Tool summary in expanded assistant view
	toolSummaryStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#B5A06A"))

	toolSummaryDimStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#908890"))

	// Separator
	separatorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#585060"))

	// Labeled section separator (─── Label ──────)
	sectionSepStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#706878"))

	// Dimmed text
	dimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#908890"))

	// Plan mode badge
	planModeStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#D0D0D0")).
			Background(lipgloss.Color("#8A5A30")).
			Padding(0, 1)

	// AskUserQuestion answer
	answerStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#8A70A0")).
			Bold(true)

	// Cursor
	cursorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#A0B0C0")).
			Bold(true)

	// Expanded text
	expandedTextStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#A098A0"))

	// Expanded text box (border around expanded content)
	expandedBoxStyle = lipgloss.NewStyle().
				Border(lipgloss.RoundedBorder()).
				BorderForeground(lipgloss.Color("#686068")).
				PaddingLeft(1)

	// Help line
	helpStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#888090"))

	// Shimmer effect (in_progress tasks)
	shimmerHighStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#FFFFFF")).
				Bold(true)

	shimmerGlowStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#D0C8A0"))

	// Pulsing activity indicator
	pulseActiveStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#6A9A78")).
				Bold(true)

	pulseDimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#709870"))

	// Markdown rendering
	mdHeaderStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color("#D0C0E0"))

	mdCodeBlockStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#B0A070"))

	mdBoldStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#D0C8D0"))

	mdInlineCodeStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#B0A070"))

	mdBulletStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#6A9A78"))

	mdTableBorderStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#686068"))

	mdTableHeaderStyle = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color("#C0B8C0"))

	mdTableCellStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#A098A0"))

	mdHorizontalRuleStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#686068"))

	// Tab bar
	tabActiveStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#D0D0D0")).
			Background(lipgloss.Color("#585060")).
			Padding(0, 1)

	tabInactiveStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#908890")).
				Padding(0, 1)

	tabLabelStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#B5A06A"))

	tabValueStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#908890"))

	// Usage score
	scoreGoodStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#6A9A78"))

	scoreFairStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#B5A06A"))

	scorePoorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#C15F3C"))

	// Score breakdown
	scoreBonusStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#6A9A78"))

	scorePenaltyStyle = lipgloss.NewStyle().
				Foreground(lipgloss.Color("#C15F3C"))
)

// Nerd Fonts glyphs (Font Awesome set).
// Requires a Nerd Font to render correctly.
const (
	nfLightbulb = "\uF0EB"
	nfEye       = "\uF06E"
	nfWrench    = "\uF0AD"
	nfArrow     = "\uF061"
)
