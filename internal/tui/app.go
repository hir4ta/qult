// Package tui implements the alfred dashboard using bubbletea v2.
package tui

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/progress"
	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/table"
	"charm.land/bubbles/v2/textinput"
	"charm.land/bubbles/v2/viewport"
	"charm.land/lipgloss/v2"
)

const (
	tabOverview   = 0
	tabTasks      = 1
	tabSpecs      = 2
	tabKnowledge  = 3
	tabCount      = 4
)

var tabNames = [tabCount]string{"Overview", "Tasks", "Specs", "Knowledge"}

// tickMsg triggers periodic data refresh.
type tickMsg time.Time

// searchResultMsg carries async semantic search results.
type searchResultMsg []KnowledgeEntry

// Model is the root bubbletea model.
type Model struct {
	ds     DataSource
	width  int
	height int

	// Tab state.
	activeTab int
	expanded  bool
	showHelp  bool

	// Bubbles components.
	specTable   table.Model
	viewport    viewport.Model
	helpModel   help.Model
	spinner     spinner.Model
	searchInput textinput.Model
	progress    progress.Model

	// Data caches.
	activeSlug string
	tasks      []TaskDetail
	specs      []SpecEntry
	knowledge  []KnowledgeEntry

	// Tasks tab state.
	taskCursor int

	// Knowledge tab state.
	knCursor    int
	searching   bool
	searchQuery string
	searchBusy  bool

	// Loading.
	loading bool
}

// New creates a new dashboard Model.
func New(ds DataSource) Model {
	sp := spinner.New(
		spinner.WithSpinner(spinner.Dot),
		spinner.WithStyle(lipgloss.NewStyle().Foreground(accent)),
	)
	h := help.New()
	h.Styles = help.DefaultStyles(true)
	ti := textinput.New()
	ti.Placeholder = "semantic search..."
	ti.CharLimit = 200
	prog := progress.New(
		progress.WithColors(accent, lipgloss.Color("#333")),
		progress.WithoutPercentage(),
		progress.WithWidth(20),
		progress.WithFillCharacters('#', '-'),
	)
	return Model{
		ds:          ds,
		helpModel:   h,
		spinner:     sp,
		searchInput: ti,
		progress:    prog,
		loading:     true,
	}
}

func (m *Model) initTables() {
	specCols := []table.Column{
		{Title: "TASK", Width: 24},
		{Title: "FILE", Width: 20},
		{Title: "SIZE", Width: 8},
	}
	m.specTable = table.New(
		table.WithColumns(specCols),
		table.WithFocused(true),
		table.WithWidth(m.width),
		table.WithHeight(m.contentHeight()),
	)
	ts := table.DefaultStyles()
	ts.Header = ts.Header.Foreground(lipgloss.Color("#666")).Bold(true)
	ts.Selected = ts.Selected.Foreground(lipgloss.Color("#fff")).Background(lipgloss.Color("#335"))
	m.specTable.SetStyles(ts)
}

func (m *Model) refreshData() {
	m.activeSlug = m.ds.ActiveTask()
	m.tasks = m.ds.TaskDetails()
	m.specs = m.ds.Specs()

	// Rebuild overview viewport content.
	m.rebuildOverview()

	// Rebuild spec table.
	rows := make([]table.Row, len(m.specs))
	for i, s := range m.specs {
		rows[i] = table.Row{s.TaskSlug, s.File, formatSize(s.Size)}
	}
	m.specTable.SetRows(rows)

	// Refresh knowledge only when not in active search.
	if !m.searching && m.searchQuery == "" && !m.searchBusy {
		m.knowledge = m.ds.RecentKnowledge(100)
	}

	m.loading = false
}

func (m *Model) rebuildOverview() {
	if m.activeTab != tabOverview || m.width == 0 {
		return
	}
	task := m.findActiveTask()
	if task == nil {
		m.viewport.SetContent(dimStyle.Render("  no active task"))
		return
	}
	m.viewport.SetContent(m.renderTaskOverview(task))
}

func (m *Model) findActiveTask() *TaskDetail {
	for i := range m.tasks {
		if m.tasks[i].Slug == m.activeSlug {
			return &m.tasks[i]
		}
	}
	if len(m.tasks) > 0 {
		return &m.tasks[0]
	}
	return nil
}

func (m Model) contentHeight() int {
	h := m.height - 5
	if h < 3 {
		return 3
	}
	return h
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(
		m.spinner.Tick,
		tea.Tick(100*time.Millisecond, func(t time.Time) tea.Msg {
			return tickMsg(t)
		}),
	)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.initTables()
		m.viewport = viewport.New(
			viewport.WithWidth(m.width-4),
			viewport.WithHeight(m.contentHeight()),
		)
		m.viewport.SoftWrap = true
		m.progress = progress.New(
			progress.WithColors(accent, lipgloss.Color("#333")),
			progress.WithoutPercentage(),
			progress.WithWidth(min(20, m.width/4)),
			progress.WithFillCharacters('#', '-'),
		)
		m.refreshData()
		return m, nil

	case tickMsg:
		m.refreshData()
		return m, tea.Tick(5*time.Second, func(t time.Time) tea.Msg {
			return tickMsg(t)
		})

	case searchResultMsg:
		m.knowledge = []KnowledgeEntry(msg)
		m.searchBusy = false
		m.knCursor = 0
		return m, nil

	case spinner.TickMsg:
		if m.loading || m.searchBusy {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			cmds = append(cmds, cmd)
		}

	case progress.FrameMsg:
		var cmd tea.Cmd
		m.progress, cmd = m.progress.Update(msg)
		cmds = append(cmds, cmd)

	case tea.KeyPressMsg:
		if m.searching {
			return m.updateSearch(msg)
		}
		if m.showHelp {
			if key.Matches(msg, keys.Help, keys.Back, keys.Quit) {
				m.showHelp = false
				return m, nil
			}
			return m, nil
		}

		switch {
		case key.Matches(msg, keys.Quit):
			return m, tea.Quit
		case key.Matches(msg, keys.Help):
			m.showHelp = !m.showHelp
			return m, nil
		case key.Matches(msg, keys.Tab):
			m.activeTab = (m.activeTab + 1) % tabCount
			m.expanded = false
			m.searchBusy = false
			if m.activeTab == tabOverview {
				m.rebuildOverview()
			}
			return m, nil
		case key.Matches(msg, keys.BackTab):
			m.activeTab = (m.activeTab - 1 + tabCount) % tabCount
			m.expanded = false
			m.searchBusy = false
			if m.activeTab == tabOverview {
				m.rebuildOverview()
			}
			return m, nil
		case key.Matches(msg, keys.Search):
			if m.activeTab == tabKnowledge && !m.expanded {
				m.searching = true
				m.searchInput.Focus()
				return m, nil
			}
		}

		// Delegate to active tab.
		switch m.activeTab {
		case tabOverview:
			m.viewport, _ = m.viewport.Update(msg)
		case tabTasks:
			return m.updateTasks(msg)
		case tabSpecs:
			if !m.expanded {
				m.specTable, _ = m.specTable.Update(msg)
				if key.Matches(msg, keys.Enter) {
					row := m.specTable.SelectedRow()
					if row != nil {
						content := m.ds.SpecContent(row[0], row[1])
						m.viewport.SetContent(content)
						m.expanded = true
					}
				}
			} else {
				m.viewport, _ = m.viewport.Update(msg)
				if key.Matches(msg, keys.Back) {
					m.expanded = false
				}
			}
		case tabKnowledge:
			return m.updateKnowledge(msg)
		}
	}

	return m, tea.Batch(cmds...)
}

func (m *Model) updateTasks(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if m.expanded {
		m.viewport, _ = m.viewport.Update(msg)
		if key.Matches(msg, keys.Back) {
			m.expanded = false
		}
		return m, nil
	}

	switch {
	case key.Matches(msg, keys.Down):
		if m.taskCursor < len(m.tasks)-1 {
			m.taskCursor++
		}
	case key.Matches(msg, keys.Up):
		if m.taskCursor > 0 {
			m.taskCursor--
		}
	case key.Matches(msg, keys.Enter):
		if m.taskCursor < len(m.tasks) {
			task := &m.tasks[m.taskCursor]
			m.viewport.SetContent(m.renderTaskOverview(task))
			m.expanded = true
		}
	}
	return m, nil
}

func (m *Model) updateKnowledge(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if m.expanded {
		m.viewport, _ = m.viewport.Update(msg)
		if key.Matches(msg, keys.Back) {
			m.expanded = false
		}
		return m, nil
	}

	switch {
	case key.Matches(msg, keys.Down):
		if m.knCursor < len(m.knowledge)-1 {
			m.knCursor++
		}
	case key.Matches(msg, keys.Up):
		if m.knCursor > 0 {
			m.knCursor--
		}
	case key.Matches(msg, keys.Enter):
		if m.knCursor < len(m.knowledge) {
			k := m.knowledge[m.knCursor]
			header := titleStyle.Render(k.Label) + "\n"
			header += dimStyle.Render(k.Source) + "  " + dimStyle.Render(formatDuration(k.Age)+" ago")
			if k.Score > 0 {
				header += "  " + scoreStyle.Render(fmt.Sprintf("%.0f%%", k.Score*100))
			}
			header += "\n\n"
			m.viewport.SetContent(header + k.Content)
			m.expanded = true
		}
	}
	return m, nil
}

func (m *Model) updateSearch(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.searching = false
		m.searchQuery = ""
		m.searchInput.SetValue("")
		m.searchInput.Blur()
		m.knowledge = m.ds.RecentKnowledge(100)
		m.knCursor = 0
		return m, nil
	case "enter":
		m.searching = false
		m.searchQuery = m.searchInput.Value()
		m.searchInput.Blur()
		if m.searchQuery == "" {
			m.knowledge = m.ds.RecentKnowledge(100)
			m.knCursor = 0
			return m, nil
		}
		m.searchBusy = true
		m.knCursor = 0
		ds := m.ds
		q := m.searchQuery
		return m, tea.Batch(
			m.spinner.Tick,
			func() tea.Msg {
				return searchResultMsg(ds.SemanticSearch(q, 20))
			},
		)
	default:
		var cmd tea.Cmd
		m.searchInput, cmd = m.searchInput.Update(msg)
		return m, cmd
	}
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

func (m Model) View() tea.View {
	if m.width == 0 {
		return tea.NewView(m.spinner.View() + " loading...")
	}

	var content string
	if m.showHelp {
		content = "\n" + m.helpModel.FullHelpView(keys.FullHelp())
	} else {
		switch m.activeTab {
		case tabOverview:
			content = m.overviewView()
		case tabTasks:
			content = m.tasksView()
		case tabSpecs:
			content = m.specsView()
		case tabKnowledge:
			content = m.knowledgeView()
		}
	}

	view := lipgloss.JoinVertical(lipgloss.Left,
		m.tabBarView(),
		content,
		m.helpBar(),
	)
	v := tea.NewView(view)
	v.AltScreen = true
	return v
}

func (m Model) tabBarView() string {
	var tabs []string
	for i, name := range tabNames {
		if i == m.activeTab {
			tabs = append(tabs, activeTabStyle.Render(name))
		} else {
			tabs = append(tabs, inactiveTabStyle.Render(name))
		}
	}
	bar := lipgloss.JoinHorizontal(lipgloss.Top, tabs...)
	title := headerStyle.Render("alfred")
	if m.loading || m.searchBusy {
		title += " " + m.spinner.View()
	}
	return title + "\n" + tabBarStyle.Width(m.width).Render(bar)
}

func (m Model) helpBar() string {
	return "\n" + m.helpModel.ShortHelpView(keys.ShortHelp())
}

// ---------------------------------------------------------------------------
// Tab views
// ---------------------------------------------------------------------------

func (m Model) overviewView() string {
	return "\n" + m.viewport.View()
}

func (m Model) renderTaskOverview(td *TaskDetail) string {
	var b strings.Builder
	maxW := m.width - 6

	// Header: slug + status + progress.
	b.WriteString("  " + titleStyle.Render(td.Slug))
	b.WriteString("  " + styledStatus(td.Status))
	if td.Total > 0 {
		pct := float64(td.Completed) / float64(td.Total)
		b.WriteString("  " + m.progress.ViewAs(pct))
		b.WriteString(fmt.Sprintf(" %d/%d", td.Completed, td.Total))
	}
	if td.EpicSlug != "" {
		b.WriteString("  " + dimStyle.Render("epic:"+td.EpicSlug))
	}
	b.WriteString("\n")

	// Focus.
	if td.Focus != "" {
		b.WriteString("  " + td.Focus + "\n")
	}
	b.WriteString("\n")

	// Blockers (prominent if present).
	if td.HasBlocker {
		b.WriteString("  " + blockerStyle.Render("! BLOCKER") + "  " + td.BlockerText + "\n\n")
	}

	// Next Steps.
	if len(td.NextSteps) > 0 {
		b.WriteString("  " + sectionHeader.Render("Next Steps") + "\n")
		for _, s := range td.NextSteps {
			check := checkUndone
			if s.Done {
				check = checkDone
			}
			text := truncStr(s.Text, maxW-6)
			if s.Done {
				b.WriteString("  " + check + " " + dimStyle.Render(text) + "\n")
			} else {
				b.WriteString("  " + check + " " + text + "\n")
			}
		}
		b.WriteString("\n")
	}

	// Recent Decisions.
	if len(td.Decisions) > 0 {
		b.WriteString("  " + sectionHeader.Render("Recent Decisions") + "\n")
		for i, d := range td.Decisions {
			b.WriteString(fmt.Sprintf("  %d. %s\n", i+1, truncStr(d, maxW-5)))
		}
		b.WriteString("\n")
	}

	// Modified Files.
	if len(td.ModFiles) > 0 {
		b.WriteString("  " + sectionHeader.Render("Modified Files") + fmt.Sprintf("  %s\n", dimStyle.Render(fmt.Sprintf("(%d)", len(td.ModFiles)))))
		for _, f := range td.ModFiles {
			b.WriteString("  " + dimStyle.Render(truncStr(f, maxW-4)) + "\n")
		}
	}

	return b.String()
}

func (m Model) tasksView() string {
	if len(m.tasks) == 0 {
		return "\n" + dimStyle.Render("  no tasks — use dossier to create one")
	}
	if m.expanded {
		return "\n" + m.viewport.View()
	}

	var b strings.Builder
	b.WriteString("\n")

	// Visible range.
	visibleH := m.contentHeight() - 1
	startIdx, endIdx := visibleRange(m.taskCursor, len(m.tasks), visibleH)

	for i := startIdx; i < endIdx; i++ {
		t := m.tasks[i]
		prefix := "  "
		if i == m.taskCursor {
			prefix = "> "
		}

		// Progress bar (inline text, no animation).
		progStr := "------"
		pctStr := "  0%"
		if t.Total > 0 {
			pct := float64(t.Completed) / float64(t.Total)
			filled := int(pct * 6)
			progStr = strings.Repeat("#", filled) + strings.Repeat("-", 6-filled)
			pctStr = fmt.Sprintf("%3d%%", int(pct*100))
		}

		slug := fmt.Sprintf("%-24s", truncStr(t.Slug, 24))
		focus := truncStr(t.Focus, m.width-52)
		if focus == "" {
			focus = dimStyle.Render("(no focus)")
		}

		blocker := " "
		if t.HasBlocker {
			blocker = blockerStyle.Render("!")
		}

		line := prefix + slug + " " + progStr + " " + pctStr + "  " + focus + " " + blocker
		isCompleted := t.Status == "completed" || t.Status == "done" || t.Status == "implementation-complete"
		if i == m.taskCursor {
			b.WriteString(titleStyle.Render(prefix+slug) + " " + progStr + " " + pctStr + "  " + focus + " " + blocker + "\n")
		} else if isCompleted {
			b.WriteString(dimStyle.Render(line) + "\n")
		} else {
			b.WriteString(line + "\n")
		}
	}

	if len(m.tasks) > visibleH {
		b.WriteString(dimStyle.Render(fmt.Sprintf("\n  %d/%d", m.taskCursor+1, len(m.tasks))))
	}

	return b.String()
}

func (m Model) specsView() string {
	if m.expanded {
		return "\n" + m.viewport.View()
	}
	if len(m.specs) == 0 {
		return "\n" + dimStyle.Render("  no specs")
	}
	return "\n" + m.specTable.View()
}

func (m Model) knowledgeView() string {
	var b strings.Builder
	b.WriteString("\n")

	// Search bar.
	if m.searching {
		b.WriteString("  " + m.searchInput.View() + "\n\n")
	} else if m.searchQuery != "" {
		b.WriteString("  search: " + titleStyle.Render(m.searchQuery))
		b.WriteString("  " + dimStyle.Render("(/ to search, esc to clear)") + "\n\n")
	}

	if m.searchBusy {
		b.WriteString("  " + m.spinner.View() + " searching...\n")
		return b.String()
	}

	if m.expanded {
		return b.String() + m.viewport.View()
	}

	if len(m.knowledge) == 0 {
		if m.searchQuery != "" {
			b.WriteString(dimStyle.Render("  no results"))
		} else {
			b.WriteString(dimStyle.Render("  no knowledge — memories will appear as you work"))
		}
		return b.String()
	}

	// Visible range.
	visibleH := m.contentHeight() - 4
	startIdx, endIdx := visibleRange(m.knCursor, len(m.knowledge), visibleH)

	for i := startIdx; i < endIdx; i++ {
		k := m.knowledge[i]
		prefix := "  "
		if i == m.knCursor {
			prefix = "> "
		}

		// Score + source tag + label + age.
		scoreStr := "     "
		if k.Score > 0 {
			scoreStr = scoreStyle.Render(fmt.Sprintf("%3.0f%% ", k.Score*100))
		}
		sourceTag := sourceStyle(k.Source)
		label := truncStr(k.Label, m.width-36)
		age := dimStyle.Render(formatDuration(k.Age))

		// Content preview.
		preview := truncStr(firstContentLine(k.Content), m.width-10)

		if i == m.knCursor {
			b.WriteString(titleStyle.Render(prefix) + scoreStr + sourceTag + " " + titleStyle.Render(label) + "  " + age + "\n")
			b.WriteString("    " + dimStyle.Render(preview) + "\n")
		} else {
			b.WriteString(prefix + scoreStr + sourceTag + " " + label + "  " + age + "\n")
			b.WriteString("    " + dimStyle.Render(preview) + "\n")
		}
	}

	if len(m.knowledge) > visibleH {
		b.WriteString(dimStyle.Render(fmt.Sprintf("\n  %d/%d", m.knCursor+1, len(m.knowledge))))
	}

	return b.String()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func visibleRange(cursor, total, visibleH int) (start, end int) {
	if visibleH < 1 {
		visibleH = 1
	}
	start = 0
	if cursor >= visibleH {
		start = cursor - visibleH + 1
	}
	end = start + visibleH
	if end > total {
		end = total
	}
	return start, end
}

func truncStr(s string, maxLen int) string {
	if maxLen <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	if maxLen < 2 {
		return string(runes[:1])
	}
	return string(runes[:maxLen-1]) + "~"
}

func formatSize(bytes int64) string {
	switch {
	case bytes >= 1024*1024:
		return fmt.Sprintf("%.1fM", float64(bytes)/1024/1024)
	case bytes >= 1024:
		return fmt.Sprintf("%.1fK", float64(bytes)/1024)
	default:
		return fmt.Sprintf("%dB", bytes)
	}
}

func formatDuration(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "now"
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

func firstContentLine(s string) string {
	for line := range strings.SplitSeq(s, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}
