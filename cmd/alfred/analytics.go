package main

import (
	"context"
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/table"
	"charm.land/bubbles/v2/viewport"
	"charm.land/lipgloss/v2"

	"github.com/hir4ta/claude-alfred/internal/store"
)

type analyticsModel struct {
	viewport viewport.Model
}

func newAnalyticsModel() (analyticsModel, error) {
	content, err := buildAnalyticsContent()
	if err != nil {
		return analyticsModel{}, err
	}

	vp := viewport.New(
		viewport.WithWidth(80),
		viewport.WithHeight(24),
	)
	vp.SetContent(content)
	vp.MouseWheelEnabled = true

	return analyticsModel{viewport: vp}, nil
}

func (m analyticsModel) Init() tea.Cmd { return nil }

func (m analyticsModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		switch msg.String() {
		case "q", "ctrl+c", "esc":
			return m, tea.Quit
		}
	case tea.WindowSizeMsg:
		m.viewport.SetWidth(msg.Width)
		m.viewport.SetHeight(msg.Height - 3) // room for help bar
	}
	var cmd tea.Cmd
	m.viewport, cmd = m.viewport.Update(msg)
	return m, cmd
}

func (m analyticsModel) View() tea.View {
	var b strings.Builder
	b.WriteString(m.viewport.View())
	b.WriteString("\n")

	h := newHelp()
	scrollPct := fmt.Sprintf(" %.0f%%", m.viewport.ScrollPercent()*100)
	b.WriteString("  " + h.View(simpleKeyMap{keyUp, keyDown, keyQuit}) + dimStyle.Render(scrollPct) + "\n")

	return tea.NewView(b.String())
}

// buildAnalyticsContent generates the full analytics text for the viewport.
func buildAnalyticsContent() (string, error) {
	st, err := store.OpenDefault()
	if err != nil {
		return "", fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	ctx := context.Background()

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7571F9"))
	okStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#04B575"))
	warnStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#FF4672"))

	var b strings.Builder

	b.WriteString("\n  " + headerStyle.Render("alfred analytics") + "\n")

	// --- Feedback Summary Table ---
	fs, err := st.GetFeedbackSummary(ctx)
	if err != nil {
		return "", fmt.Errorf("feedback summary: %w", err)
	}

	b.WriteString("\n  " + headerStyle.Render("Feedback Loop") + "\n\n")

	feedbackCols := []table.Column{
		{Title: "Metric", Width: 24},
		{Title: "Value", Width: 16},
	}
	feedbackRows := []table.Row{
		{"Docs tracked", fmt.Sprintf("%d", fs.TotalTracked)},
		{"Positive signals", okStyle.Render(fmt.Sprintf("+%d", fs.TotalPositive))},
		{"Negative signals", warnStyle.Render(fmt.Sprintf("-%d", fs.TotalNegative))},
		{"Boosted docs", fmt.Sprintf("%d", fs.BoostedCount)},
		{"Penalized docs", fmt.Sprintf("%d", fs.PenalizedCount)},
	}
	ft := table.New(
		table.WithColumns(feedbackCols),
		table.WithRows(feedbackRows),
		table.WithHeight(len(feedbackRows)),
	)
	fts := table.DefaultStyles()
	fts.Header = fts.Header.Bold(true).BorderStyle(lipgloss.NormalBorder()).BorderBottom(true).BorderForeground(lipgloss.Color("#626262"))
	fts.Selected = lipgloss.NewStyle() // no selection highlighting in non-focused table
	ft.SetStyles(fts)
	b.WriteString(indentBlock(ft.View(), "  ") + "\n")

	// --- Injection Activity Table ---
	injected7, unique7, _ := st.RecentInjectionStats(ctx, 7)
	injected30, unique30, _ := st.RecentInjectionStats(ctx, 30)

	b.WriteString("\n  " + headerStyle.Render("Injection Activity") + "\n\n")

	injCols := []table.Column{
		{Title: "Period", Width: 16},
		{Title: "Injections", Width: 12},
		{Title: "Unique Docs", Width: 12},
	}
	injRows := []table.Row{
		{"Last 7 days", fmt.Sprintf("%d", injected7), fmt.Sprintf("%d", unique7)},
		{"Last 30 days", fmt.Sprintf("%d", injected30), fmt.Sprintf("%d", unique30)},
	}
	it := table.New(
		table.WithColumns(injCols),
		table.WithRows(injRows),
		table.WithHeight(len(injRows)),
	)
	its := table.DefaultStyles()
	its.Header = its.Header.Bold(true).BorderStyle(lipgloss.NormalBorder()).BorderBottom(true).BorderForeground(lipgloss.Color("#626262"))
	its.Selected = lipgloss.NewStyle()
	it.SetStyles(its)
	b.WriteString(indentBlock(it.View(), "  ") + "\n")

	// --- Top Boosted Docs Table ---
	topBoosted, _ := st.TopFeedbackDocs(ctx, 5, false)
	if len(topBoosted) > 0 {
		b.WriteString("\n  " + headerStyle.Render("Top Boosted Docs") + "\n\n")

		boostCols := []table.Column{
			{Title: "Document", Width: 36},
			{Title: "Signals", Width: 16},
			{Title: "Boost", Width: 8},
		}
		var boostRows []table.Row
		for _, d := range topBoosted {
			net := d.Positive - d.Negative
			boostRows = append(boostRows, table.Row{
				truncateStr(d.SectionPath, 34),
				okStyle.Render(fmt.Sprintf("+%d/-%d net=%d", d.Positive, d.Negative, net)),
				fmt.Sprintf("%.2f", d.BoostFactor),
			})
		}
		bt := table.New(
			table.WithColumns(boostCols),
			table.WithRows(boostRows),
			table.WithHeight(len(boostRows)),
		)
		bts := table.DefaultStyles()
		bts.Header = bts.Header.Bold(true).BorderStyle(lipgloss.NormalBorder()).BorderBottom(true).BorderForeground(lipgloss.Color("#626262"))
		bts.Selected = lipgloss.NewStyle()
		bt.SetStyles(bts)
		b.WriteString(indentBlock(bt.View(), "  ") + "\n")
	}

	// --- Top Penalized Docs Table ---
	topPenalized, _ := st.TopFeedbackDocs(ctx, 5, true)
	if len(topPenalized) > 0 {
		b.WriteString("\n  " + headerStyle.Render("Top Penalized Docs") + "\n\n")

		penCols := []table.Column{
			{Title: "Document", Width: 36},
			{Title: "Signals", Width: 16},
			{Title: "Boost", Width: 8},
		}
		var penRows []table.Row
		for _, d := range topPenalized {
			net := d.Positive - d.Negative
			penRows = append(penRows, table.Row{
				truncateStr(d.SectionPath, 34),
				warnStyle.Render(fmt.Sprintf("+%d/-%d net=%d", d.Positive, d.Negative, net)),
				fmt.Sprintf("%.2f", d.BoostFactor),
			})
		}
		pt := table.New(
			table.WithColumns(penCols),
			table.WithRows(penRows),
			table.WithHeight(len(penRows)),
		)
		pts := table.DefaultStyles()
		pts.Header = pts.Header.Bold(true).BorderStyle(lipgloss.NormalBorder()).BorderBottom(true).BorderForeground(lipgloss.Color("#626262"))
		pts.Selected = lipgloss.NewStyle()
		pt.SetStyles(pts)
		b.WriteString(indentBlock(pt.View(), "  ") + "\n")
	}

	b.WriteString("\n")
	return b.String(), nil
}

// indentBlock adds prefix to each line of a multi-line string.
func indentBlock(s, prefix string) string {
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		if line != "" {
			lines[i] = prefix + line
		}
	}
	return strings.Join(lines, "\n")
}

func runAnalytics() error {
	m, err := newAnalyticsModel()
	if err != nil {
		return err
	}
	_, err = tea.NewProgram(m).Run()
	return err
}
