// Package tui implements the alfred dashboard using bubbletea v2.
package tui

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textinput"
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
	ds          DataSource
	width       int
	height      int
	activeTab   int
	cursor      int
	expanded    bool // drilldown mode
	expandedIdx int

	// Data caches (refreshed on tick).
	epics    []EpicSummary
	tasks    []TaskSummary
	specs    []SpecEntry
	memories []MemoryEntry

	// Spec viewer.
	specContent string

	// Memory search.
	searchInput textinput.Model
	searching   bool
	searchQuery string
}

// New creates a new dashboard Model.
func New(ds DataSource) Model {
	ti := textinput.New()
	ti.Placeholder = "search memories..."
	ti.CharLimit = 200

	m := Model{
		ds:          ds,
		searchInput: ti,
	}
	m.refreshData()
	return m
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
}

func (m Model) Init() tea.Cmd {
	return tea.Tick(5*time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tickMsg:
		m.refreshData()
		return m, tea.Tick(5*time.Second, func(t time.Time) tea.Msg {
			return tickMsg(t)
		})

	case tea.KeyPressMsg:
		// Search mode captures all keys.
		if m.searching {
			return m.updateSearch(msg)
		}

		switch {
		case key.Matches(msg, keys.Quit):
			return m, tea.Quit
		case key.Matches(msg, keys.Tab):
			m.activeTab = (m.activeTab + 1) % tabCount
			m.cursor = 0
			m.expanded = false
			return m, nil
		case key.Matches(msg, keys.BackTab):
			m.activeTab = (m.activeTab - 1 + tabCount) % tabCount
			m.cursor = 0
			m.expanded = false
			return m, nil
		case key.Matches(msg, keys.Down):
			m.cursor++
			m.clampCursor()
			return m, nil
		case key.Matches(msg, keys.Up):
			m.cursor--
			m.clampCursor()
			return m, nil
		case key.Matches(msg, keys.Enter):
			return m.handleEnter()
		case key.Matches(msg, keys.Back):
			if m.expanded {
				m.expanded = false
				m.specContent = ""
				return m, nil
			}
		case key.Matches(msg, keys.Search):
			if m.activeTab == tabMemories {
				m.searching = true
				m.searchInput.Focus()
				return m, nil
			}
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
		m.refreshData()
		return m, nil
	default:
		var cmd tea.Cmd
		m.searchInput, cmd = m.searchInput.Update(msg)
		return m, cmd
	}
}

func (m *Model) handleEnter() (tea.Model, tea.Cmd) {
	switch m.activeTab {
	case tabEpics:
		if !m.expanded && m.cursor < len(m.epics) {
			m.expanded = true
			m.expandedIdx = m.cursor
			m.cursor = 0
		}
	case tabSpecs:
		if !m.expanded && m.cursor < len(m.specs) {
			entry := m.specs[m.cursor]
			m.specContent = m.ds.SpecContent(entry.TaskSlug, entry.File)
			m.expanded = true
		} else if m.expanded {
			m.expanded = false
			m.specContent = ""
		}
	case tabMemories:
		if !m.expanded && m.cursor < len(m.memories) {
			m.expanded = true
			m.expandedIdx = m.cursor
		} else if m.expanded {
			m.expanded = false
		}
	}
	return m, nil
}

func (m *Model) clampCursor() {
	max := m.currentListLen() - 1
	if max < 0 {
		max = 0
	}
	if m.cursor > max {
		m.cursor = max
	}
	if m.cursor < 0 {
		m.cursor = 0
	}
}

func (m *Model) currentListLen() int {
	switch m.activeTab {
	case tabEpics:
		if m.expanded && m.expandedIdx < len(m.epics) {
			return len(m.epics[m.expandedIdx].Tasks)
		}
		return len(m.epics)
	case tabTasks:
		return len(m.tasks)
	case tabSpecs:
		return len(m.specs)
	case tabMemories:
		return len(m.memories)
	}
	return 0
}

func (m Model) View() tea.View {
	if m.width == 0 {
		return tea.NewView("loading...")
	}

	var content string
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

	// Calculate available height for content.
	headerHeight := 3 // title + tabs + border
	helpHeight := 2
	contentHeight := m.height - headerHeight - helpHeight
	if contentHeight < 1 {
		contentHeight = 1
	}

	// Trim content to fit.
	contentLines := strings.Split(content, "\n")
	if len(contentLines) > contentHeight {
		contentLines = contentLines[:contentHeight]
	}
	content = strings.Join(contentLines, "\n")

	view := lipgloss.JoinVertical(lipgloss.Left,
		m.tabBarView(),
		content,
		m.helpView(),
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
	return headerStyle.Render("alfred") + "\n" + tabBarStyle.Width(m.width).Render(bar)
}

func (m Model) helpView() string {
	var parts []string
	parts = append(parts, dimStyle.Render("tab")+" switch")
	parts = append(parts, dimStyle.Render("j/k")+" navigate")
	if m.expanded {
		parts = append(parts, dimStyle.Render("esc")+" back")
	} else {
		parts = append(parts, dimStyle.Render("enter")+" expand")
	}
	if m.activeTab == tabMemories {
		parts = append(parts, dimStyle.Render("/")+" search")
	}
	parts = append(parts, dimStyle.Render("q")+" quit")
	return helpStyle.Render(strings.Join(parts, "  "))
}

// ---------------------------------------------------------------------------
// Tab views
// ---------------------------------------------------------------------------

func (m Model) epicsView() string {
	if len(m.epics) == 0 {
		return dimStyle.Render("  no epics")
	}

	if m.expanded && m.expandedIdx < len(m.epics) {
		return m.epicDetailView(m.epics[m.expandedIdx])
	}

	var b strings.Builder
	b.WriteString("\n")
	for i, e := range m.epics {
		prefix := "  "
		if i == m.cursor {
			prefix = "> "
		}
		pct := ""
		if e.Total > 0 {
			pct = fmt.Sprintf(" %d%%", e.Completed*100/e.Total)
		}
		line := fmt.Sprintf("%s%-24s %d/%d  %s%s",
			prefix,
			truncStr(e.Name, 24),
			e.Completed, e.Total,
			renderProgress(e.Completed, e.Total, 16),
			pct,
		)
		if i == m.cursor {
			b.WriteString(selectedStyle.Render(line))
		} else {
			b.WriteString(line)
		}
		b.WriteString("\n")
	}

	// Show standalone task count.
	standalone := 0
	for _, t := range m.tasks {
		if t.EpicSlug == "" {
			standalone++
		}
	}
	if standalone > 0 {
		b.WriteString(dimStyle.Render(fmt.Sprintf("\n  (%d standalone tasks)", standalone)))
	}

	return b.String()
}

func (m Model) epicDetailView(e EpicSummary) string {
	var b strings.Builder
	b.WriteString("\n")
	b.WriteString(titleStyle.Render(fmt.Sprintf("  %s", e.Name)))
	b.WriteString(dimStyle.Render(fmt.Sprintf("  %s", e.Slug)))
	b.WriteString("\n\n")

	for i, t := range e.Tasks {
		prefix := "  "
		if i == m.cursor {
			prefix = "> "
		}
		deps := ""
		if len(t.DependsOn) > 0 {
			deps = dimStyle.Render(fmt.Sprintf("  depends: %s", strings.Join(t.DependsOn, ", ")))
		}
		line := fmt.Sprintf("%s%-28s %s%s",
			prefix,
			truncStr(t.Slug, 28),
			styledStatus(t.Status),
			deps,
		)
		if i == m.cursor {
			b.WriteString(selectedStyle.Render(line))
		} else {
			b.WriteString(line)
		}
		b.WriteString("\n")
	}
	return b.String()
}

func (m Model) tasksView() string {
	if len(m.tasks) == 0 {
		return dimStyle.Render("  no tasks")
	}

	var b strings.Builder
	b.WriteString("\n")
	// Header.
	hdr := fmt.Sprintf("  %-28s %-16s %s", "TASK", "EPIC", "STATUS")
	b.WriteString(dimStyle.Render(hdr))
	b.WriteString("\n")

	for i, t := range m.tasks {
		prefix := "  "
		if i == m.cursor {
			prefix = "> "
		}
		epicName := dimStyle.Render("--")
		if t.EpicSlug != "" {
			epicName = t.EpicSlug
		}
		line := fmt.Sprintf("%s%-28s %-16s %s",
			prefix,
			truncStr(t.Slug, 28),
			truncStr(epicName, 16),
			styledStatus(t.Status),
		)
		if i == m.cursor {
			b.WriteString(selectedStyle.Render(line))
		} else {
			b.WriteString(line)
		}
		b.WriteString("\n")
	}
	return b.String()
}

func (m Model) specsView() string {
	if m.expanded && m.specContent != "" {
		return "\n" + viewportBorder.Width(m.width-4).Render(m.specContent)
	}

	if len(m.specs) == 0 {
		return dimStyle.Render("  no specs")
	}

	var b strings.Builder
	b.WriteString("\n")
	hdr := fmt.Sprintf("  %-24s %-20s %8s", "TASK", "FILE", "SIZE")
	b.WriteString(dimStyle.Render(hdr))
	b.WriteString("\n")

	for i, s := range m.specs {
		prefix := "  "
		if i == m.cursor {
			prefix = "> "
		}
		size := formatSize(s.Size)
		line := fmt.Sprintf("%s%-24s %-20s %8s",
			prefix,
			truncStr(s.TaskSlug, 24),
			s.File,
			size,
		)
		if i == m.cursor {
			b.WriteString(selectedStyle.Render(line))
		} else {
			b.WriteString(line)
		}
		b.WriteString("\n")
	}
	return b.String()
}

func (m Model) memoriesView() string {
	var b strings.Builder
	b.WriteString("\n")

	// Search bar.
	if m.searching {
		b.WriteString("  " + m.searchInput.View())
		b.WriteString("\n\n")
	} else if m.searchQuery != "" {
		b.WriteString(fmt.Sprintf("  search: %s", titleStyle.Render(m.searchQuery)))
		b.WriteString(dimStyle.Render("  (/ to search, esc to clear)"))
		b.WriteString("\n\n")
	}

	if m.expanded && m.expandedIdx < len(m.memories) {
		mem := m.memories[m.expandedIdx]
		b.WriteString(titleStyle.Render("  "+mem.Label) + "\n")
		b.WriteString(dimStyle.Render(fmt.Sprintf("  %s  %s ago", mem.Project, formatDuration(mem.Age))) + "\n\n")
		b.WriteString(viewportBorder.Width(m.width - 4).Render(mem.Content))
		return b.String()
	}

	if len(m.memories) == 0 {
		b.WriteString(dimStyle.Render("  no memories"))
		return b.String()
	}

	hdr := fmt.Sprintf("  %-40s %-12s %s", "LABEL", "PROJECT", "AGE")
	b.WriteString(dimStyle.Render(hdr))
	b.WriteString("\n")

	for i, mem := range m.memories {
		prefix := "  "
		if i == m.cursor {
			prefix = "> "
		}
		line := fmt.Sprintf("%s%-40s %-12s %s",
			prefix,
			truncStr(mem.Label, 40),
			truncStr(mem.Project, 12),
			formatDuration(mem.Age),
		)
		if i == m.cursor {
			b.WriteString(selectedStyle.Render(line))
		} else {
			b.WriteString(line)
		}
		b.WriteString("\n")
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
