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
	tabEpics    = 0
	tabTasks    = 1
	tabSpecs    = 2
	tabMemories = 3
	tabCount    = 4
)

var tabNames = [tabCount]string{"Epics", "Tasks", "Specs", "Memories"}

// tickMsg triggers periodic data refresh.
type tickMsg time.Time

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
	taskTable   table.Model
	specTable   table.Model
	viewport    viewport.Model
	helpModel   help.Model
	spinner     spinner.Model
	searchInput textinput.Model
	progress    progress.Model

	// Data caches.
	epics    []EpicSummary
	tasks    []TaskSummary
	specs    []SpecEntry
	memories []MemoryEntry

	// Epic drilldown state.
	epicCursor  int
	epicExpIdx  int
	taskCursor  int // cursor within expanded epic

	// Memory state.
	memCursor   int
	memExpIdx   int
	searching   bool
	searchQuery string

	// Loading.
	loading bool
}

// New creates a new dashboard Model.
func New(ds DataSource) Model {
	// Spinner.
	sp := spinner.New(
		spinner.WithSpinner(spinner.Dot),
		spinner.WithStyle(lipgloss.NewStyle().Foreground(accent)),
	)

	// Help.
	h := help.New()
	h.Styles = help.DefaultStyles(true) // dark mode

	// Search input.
	ti := textinput.New()
	ti.Placeholder = "search memories..."
	ti.CharLimit = 200

	// Progress bar.
	prog := progress.New(
		progress.WithColors(accent, lipgloss.Color("#333")),
		progress.WithoutPercentage(),
		progress.WithWidth(20),
		progress.WithFillCharacters('#', '-'),
	)

	m := Model{
		ds:          ds,
		helpModel:   h,
		spinner:     sp,
		searchInput: ti,
		progress:    prog,
		loading:     true,
	}
	return m
}

func (m *Model) initTables() {
	// Task table.
	taskCols := []table.Column{
		{Title: "TASK", Width: 28},
		{Title: "EPIC", Width: 16},
		{Title: "STATUS", Width: 14},
	}
	m.taskTable = table.New(
		table.WithColumns(taskCols),
		table.WithFocused(true),
		table.WithHeight(m.contentHeight()),
	)
	ts := table.DefaultStyles()
	ts.Header = ts.Header.Foreground(lipgloss.Color("#666")).Bold(true)
	ts.Selected = ts.Selected.Foreground(lipgloss.Color("#fff")).Background(lipgloss.Color("#335"))
	m.taskTable.SetStyles(ts)

	// Spec table.
	specCols := []table.Column{
		{Title: "TASK", Width: 24},
		{Title: "FILE", Width: 20},
		{Title: "SIZE", Width: 8},
	}
	m.specTable = table.New(
		table.WithColumns(specCols),
		table.WithFocused(true),
		table.WithHeight(m.contentHeight()),
	)
	m.specTable.SetStyles(ts)
}

func (m *Model) refreshData() {
	m.epics = m.ds.Epics()
	m.tasks = m.ds.Tasks()
	m.specs = m.ds.Specs()
	if m.searching && m.searchQuery != "" {
		m.memories = m.ds.SearchMemories(m.searchQuery)
	} else {
		m.memories = m.ds.Memories(100)
	}

	// Rebuild table rows.
	m.rebuildTaskRows()
	m.rebuildSpecRows()
	m.loading = false
}

func (m *Model) rebuildTaskRows() {
	rows := make([]table.Row, len(m.tasks))
	for i, t := range m.tasks {
		epicCol := "--"
		if t.EpicSlug != "" {
			epicCol = t.EpicSlug
		}
		rows[i] = table.Row{t.Slug, epicCol, t.Status}
	}
	m.taskTable.SetRows(rows)
}

func (m *Model) rebuildSpecRows() {
	rows := make([]table.Row, len(m.specs))
	for i, s := range m.specs {
		rows[i] = table.Row{s.TaskSlug, s.File, formatSize(s.Size)}
	}
	m.specTable.SetRows(rows)
}

func (m Model) contentHeight() int {
	h := m.height - 5 // header + tabs + help
	if h < 3 {
		return 3
	}
	return h
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(
		m.spinner.Tick,
		tea.Tick(100*time.Millisecond, func(t time.Time) tea.Msg {
			return tickMsg(t) // fast first load
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
		// help.Model width is set via its view methods, not a field.
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

	case spinner.TickMsg:
		if m.loading {
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
			return m, nil
		case key.Matches(msg, keys.BackTab):
			m.activeTab = (m.activeTab - 1 + tabCount) % tabCount
			m.expanded = false
			return m, nil
		case key.Matches(msg, keys.Search):
			if m.activeTab == tabMemories && !m.expanded {
				m.searching = true
				m.searchInput.Focus()
				return m, nil
			}
		}

		// Delegate to active tab.
		switch m.activeTab {
		case tabEpics:
			return m.updateEpics(msg)
		case tabTasks:
			if !m.expanded {
				m.taskTable, _ = m.taskTable.Update(msg)
			} else {
				m.viewport, _ = m.viewport.Update(msg)
				if key.Matches(msg, keys.Back) {
					m.expanded = false
				}
			}
			if key.Matches(msg, keys.Enter) && !m.expanded {
				row := m.taskTable.SelectedRow()
				if row != nil {
					content := m.ds.SpecContent(row[0], "session.md")
					m.viewport.SetContent(content)
					m.expanded = true
				}
			}
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
		case tabMemories:
			return m.updateMemories(msg)
		}
	}

	return m, tea.Batch(cmds...)
}

func (m *Model) updateEpics(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if !m.expanded {
		switch {
		case key.Matches(msg, keys.Down):
			if m.epicCursor < len(m.epics)-1 {
				m.epicCursor++
			}
		case key.Matches(msg, keys.Up):
			if m.epicCursor > 0 {
				m.epicCursor--
			}
		case key.Matches(msg, keys.Enter):
			if m.epicCursor < len(m.epics) {
				m.expanded = true
				m.epicExpIdx = m.epicCursor
				m.taskCursor = 0
			}
		}
	} else {
		ep := m.epics[m.epicExpIdx]
		switch {
		case key.Matches(msg, keys.Down):
			if m.taskCursor < len(ep.Tasks)-1 {
				m.taskCursor++
			}
		case key.Matches(msg, keys.Up):
			if m.taskCursor > 0 {
				m.taskCursor--
			}
		case key.Matches(msg, keys.Back):
			m.expanded = false
		}
	}
	return m, nil
}

func (m *Model) updateMemories(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if m.expanded {
		m.viewport, _ = m.viewport.Update(msg)
		if key.Matches(msg, keys.Back) {
			m.expanded = false
		}
		return m, nil
	}

	switch {
	case key.Matches(msg, keys.Down):
		if m.memCursor < len(m.memories)-1 {
			m.memCursor++
		}
	case key.Matches(msg, keys.Up):
		if m.memCursor > 0 {
			m.memCursor--
		}
	case key.Matches(msg, keys.Enter):
		if m.memCursor < len(m.memories) {
			mem := m.memories[m.memCursor]
			header := fmt.Sprintf("%s\n%s  %s ago\n\n",
				titleStyle.Render(mem.Label),
				dimStyle.Render(mem.Project),
				dimStyle.Render(formatDuration(mem.Age)),
			)
			m.viewport.SetContent(header + mem.Content)
			m.expanded = true
			m.memExpIdx = m.memCursor
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
		m.refreshData()
		return m, nil
	case "enter":
		m.searching = false
		m.searchQuery = m.searchInput.Value()
		m.searchInput.Blur()
		m.memCursor = 0
		m.refreshData()
		return m, nil
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
		case tabEpics:
			content = m.epicsView()
		case tabTasks:
			content = m.tasksView()
		case tabSpecs:
			content = m.specsView()
		case tabMemories:
			content = m.memoriesView()
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
	if m.loading {
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

func (m Model) epicsView() string {
	if len(m.epics) == 0 {
		return "\n" + dimStyle.Render("  no epics — use roster to create one")
	}

	if m.expanded && m.epicExpIdx < len(m.epics) {
		return m.epicDetailView(m.epics[m.epicExpIdx])
	}

	var b strings.Builder
	b.WriteString("\n")
	for i, e := range m.epics {
		prefix := "  "
		if i == m.epicCursor {
			prefix = "> "
		}

		// Progress bar via bubbles.
		pct := float64(0)
		pctStr := ""
		if e.Total > 0 {
			pct = float64(e.Completed) / float64(e.Total)
			pctStr = fmt.Sprintf(" %d%%", int(pct*100))
		}

		name := fmt.Sprintf("%-24s", truncStr(e.Name, 24))
		count := fmt.Sprintf("%d/%d ", e.Completed, e.Total)
		bar := m.progress.ViewAs(pct)

		line := prefix + name + count + bar + pctStr
		if i == m.epicCursor {
			// Highlight entire line - render name/count in accent.
			line = prefix + titleStyle.Render(fmt.Sprintf("%-24s", truncStr(e.Name, 24))) +
				count + bar + pctStr
		}
		b.WriteString(line + "\n")
	}

	// Standalone task count.
	standalone := 0
	for _, t := range m.tasks {
		if t.EpicSlug == "" {
			standalone++
		}
	}
	if standalone > 0 {
		b.WriteString("\n" + dimStyle.Render(fmt.Sprintf("  (%d standalone tasks)", standalone)))
	}

	return b.String()
}

func (m Model) epicDetailView(e EpicSummary) string {
	var b strings.Builder
	b.WriteString("\n")

	// Epic header with progress.
	pct := float64(0)
	if e.Total > 0 {
		pct = float64(e.Completed) / float64(e.Total)
	}
	b.WriteString("  " + titleStyle.Render(e.Name))
	b.WriteString("  " + dimStyle.Render(e.Slug))
	b.WriteString("  " + m.progress.ViewAs(pct))
	b.WriteString(fmt.Sprintf(" %d/%d", e.Completed, e.Total))
	b.WriteString("\n\n")

	for i, t := range e.Tasks {
		prefix := "  "
		if i == m.taskCursor {
			prefix = "> "
		}
		deps := ""
		if len(t.DependsOn) > 0 {
			deps = "  " + dimStyle.Render("depends: "+strings.Join(t.DependsOn, ", "))
		}

		slug := fmt.Sprintf("%-28s", truncStr(t.Slug, 28))
		status := styledStatus(t.Status)

		if i == m.taskCursor {
			b.WriteString(prefix + titleStyle.Render(slug) + " " + status + deps + "\n")
		} else {
			b.WriteString(prefix + slug + " " + status + deps + "\n")
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
	return "\n" + m.taskTable.View()
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

func (m Model) memoriesView() string {
	var b strings.Builder
	b.WriteString("\n")

	// Search bar.
	if m.searching {
		b.WriteString("  " + m.searchInput.View() + "\n\n")
	} else if m.searchQuery != "" {
		b.WriteString("  search: " + titleStyle.Render(m.searchQuery))
		b.WriteString("  " + dimStyle.Render("(/ to search, esc to clear)") + "\n\n")
	}

	if m.expanded {
		return b.String() + m.viewport.View()
	}

	if len(m.memories) == 0 {
		b.WriteString(dimStyle.Render("  no memories"))
		return b.String()
	}

	// Header.
	hdr := fmt.Sprintf("  %-40s %-12s %s", "LABEL", "PROJECT", "AGE")
	b.WriteString(dimStyle.Render(hdr) + "\n")

	// Visible range (simple pagination).
	visibleH := m.contentHeight() - 4
	if visibleH < 1 {
		visibleH = 1
	}
	startIdx := 0
	if m.memCursor >= visibleH {
		startIdx = m.memCursor - visibleH + 1
	}
	endIdx := startIdx + visibleH
	if endIdx > len(m.memories) {
		endIdx = len(m.memories)
	}

	for i := startIdx; i < endIdx; i++ {
		mem := m.memories[i]
		prefix := "  "
		if i == m.memCursor {
			prefix = "> "
		}
		line := fmt.Sprintf("%s%-40s %-12s %s",
			prefix,
			truncStr(mem.Label, 40),
			truncStr(mem.Project, 12),
			formatDuration(mem.Age),
		)
		if i == m.memCursor {
			b.WriteString(titleStyle.Render(line) + "\n")
		} else {
			b.WriteString(line + "\n")
		}
	}

	// Scroll indicator.
	if len(m.memories) > visibleH {
		b.WriteString(dimStyle.Render(fmt.Sprintf("\n  %d/%d", m.memCursor+1, len(m.memories))))
	}

	return b.String()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func truncStr(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + "~"
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
