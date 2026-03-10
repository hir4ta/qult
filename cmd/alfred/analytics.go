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
	showHelp bool
	width    int
	height   int
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
			if m.showHelp {
				m.showHelp = false
				return m, nil
			}
			return m, tea.Quit
		case "?":
			m.showHelp = !m.showHelp
			return m, nil
		}
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.viewport.SetWidth(msg.Width)
		m.viewport.SetHeight(msg.Height - 3) // room for help bar
	}
	var cmd tea.Cmd
	m.viewport, cmd = m.viewport.Update(msg)
	return m, cmd
}

func (m analyticsModel) View() tea.View {
	if m.showHelp {
		return tea.NewView(m.renderHelpOverlay())
	}

	var b strings.Builder
	b.WriteString(m.viewport.View())
	b.WriteString("\n")

	h := newHelp()
	scrollPct := fmt.Sprintf(" %.0f%%", m.viewport.ScrollPercent()*100)
	b.WriteString("  " + h.View(simpleKeyMap{keyUp, keyDown, keyHelp, keyQuit}) + dimStyle.Render(scrollPct) + "\n")

	return tea.NewView(b.String())
}

func (m analyticsModel) renderHelpOverlay() string {
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7571F9"))
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#FFB627"))
	descStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#AAAAAA"))

	var b strings.Builder
	b.WriteString("\n  " + headerStyle.Render("Analytics Help") + "\n\n")

	sections := []struct{ title, desc string }{
		{
			"Feedback Loop",
			"Tracks the effectiveness of knowledge injection.\n" +
				"    Docs tracked   — total documents with feedback signals\n" +
				"    Positive       — injected docs the user actually referenced (+)\n" +
				"    Negative       — injected docs that were ignored (-)\n" +
				"    Boosted/Penalized — docs whose boost factor has shifted",
		},
		{
			"Injection Activity",
			"How often the UserPromptSubmit hook injects knowledge.\n" +
				"    Injections     — number of injection events\n" +
				"    Unique Docs    — distinct documents used in injections",
		},
		{
			"Top Boosted Docs",
			"Documents most frequently referenced after injection.\n" +
				"    Higher boost factor = prioritized in future searches.\n" +
				"    Signals +N/-M  — positive/negative signal counts",
		},
		{
			"Top Penalized Docs",
			"Documents that were injected but consistently ignored.\n" +
				"    Boost factor < 1.0 lowers their search ranking.\n" +
				"    Consider improving or removing high-negative docs.",
		},
	}

	for _, s := range sections {
		b.WriteString("  " + titleStyle.Render(s.title) + "\n")
		b.WriteString("  " + descStyle.Render(s.desc) + "\n\n")
	}

	b.WriteString("  " + descStyle.Render("Press ? or Esc to close") + "\n")
	return b.String()
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
		{"Positive signals", fmt.Sprintf("+%d", fs.TotalPositive)},
		{"Negative signals", fmt.Sprintf("-%d", fs.TotalNegative)},
		{"Boosted docs", fmt.Sprintf("%d", fs.BoostedCount)},
		{"Penalized docs", fmt.Sprintf("%d", fs.PenalizedCount)},
	}
	ft := newStaticTable(feedbackCols, feedbackRows)
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
	it := newStaticTable(injCols, injRows)
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
				fmt.Sprintf("+%d/-%d net=%d", d.Positive, d.Negative, net),
				fmt.Sprintf("%.2f", d.BoostFactor),
			})
		}
		bt := newStaticTable(boostCols, boostRows)
		b.WriteString(indentBlock(bt.View(), "  ") + "\n")
	}

	// --- Top Penalized Docs Table (only if there are actually penalized docs) ---
	topPenalized, _ := st.TopFeedbackDocs(ctx, 5, true)
	if fs.PenalizedCount > 0 && len(topPenalized) > 0 {
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
				fmt.Sprintf("+%d/-%d net=%d", d.Positive, d.Negative, net),
				fmt.Sprintf("%.2f", d.BoostFactor),
			})
		}
		pt := newStaticTable(penCols, penRows)
		b.WriteString(indentBlock(pt.View(), "  ") + "\n")
	}

	b.WriteString("\n")
	return b.String(), nil
}

// newStaticTable creates a non-interactive table for display purposes.
func newStaticTable(cols []table.Column, rows []table.Row) table.Model {
	w := 0
	for _, c := range cols {
		w += c.Width + 2
	}
	t := table.New(
		table.WithColumns(cols),
		table.WithRows(rows),
		table.WithWidth(w),
		table.WithHeight(len(rows)),
	)
	s := table.DefaultStyles()
	s.Header = s.Header.Bold(true).
		BorderStyle(lipgloss.NormalBorder()).
		BorderBottom(true).
		BorderForeground(lipgloss.Color("#626262"))
	s.Selected = lipgloss.NewStyle()
	t.SetStyles(s)
	t.UpdateViewport()
	return t
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
