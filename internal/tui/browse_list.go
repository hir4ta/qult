package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

func (m BrowseModel) updateList(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.searching {
		return m.updateSearch(msg)
	}

	count := m.visibleCount()
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < count-1 {
			m.cursor++
		}
	case "/":
		m.searching = true
		return m, nil
	case "esc":
		if m.searchQuery != "" {
			m.searchQuery = ""
			m.filtered = nil
			m.cursor = 0
		}
		return m, nil
	case "enter":
		visible := m.visibleSessions()
		if m.cursor < len(visible) {
			si := visible[m.cursor]
			return m, func() tea.Msg {
				detail, err := watcher.LoadSessionDetail(si)
				return sessionLoadedMsg{detail: detail, err: err}
			}
		}
	}
	return m, nil
}

func (m BrowseModel) updateSearch(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyEscape:
		m.searching = false
		m.searchQuery = ""
		m.filtered = nil
		m.cursor = 0
		return m, nil
	case tea.KeyEnter:
		m.searching = false
		return m, nil
	case tea.KeyBackspace:
		if len(m.searchQuery) > 0 {
			runes := []rune(m.searchQuery)
			m.searchQuery = string(runes[:len(runes)-1])
			m.applyFilter()
		}
		return m, nil
	default:
		if msg.Type == tea.KeyRunes {
			m.searchQuery += msg.String()
			m.applyFilter()
		}
		return m, nil
	}
}

func (m BrowseModel) viewList() string {
	var b strings.Builder

	b.WriteString(headerStyle.Render(" claude-buddy browse "))
	b.WriteString("\n")

	sessions := m.visibleSessions()

	if m.searching || m.searchQuery != "" {
		b.WriteString(statsStyle.Render(fmt.Sprintf("%d / %d sessions", len(sessions), len(m.sessions))))
		b.WriteString("  ")
		searchLabel := userMsgStyle.Render("/")
		b.WriteString(searchLabel + m.searchQuery)
		if m.searching {
			b.WriteString(cursorStyle.Render("\u2588")) // block cursor
		}
	} else {
		b.WriteString(statsStyle.Render(fmt.Sprintf("%d sessions found", len(m.sessions))))
	}
	b.WriteString("\n")
	b.WriteString(separatorStyle.Render(strings.Repeat("\u2500", max(m.width, 40))))
	b.WriteString("\n")

	if len(sessions) == 0 {
		if m.searchQuery != "" {
			b.WriteString(dimStyle.Render("  No matching sessions"))
		} else {
			b.WriteString(dimStyle.Render("  No sessions found"))
		}
		b.WriteString("\n")
		b.WriteString(separatorStyle.Render(strings.Repeat("\u2500", max(m.width, 40))))
		b.WriteString("\n")
		if m.searching {
			b.WriteString(helpStyle.Render("  Enter: confirm | Esc: clear search"))
		} else {
			b.WriteString(helpStyle.Render("  /: search | q: quit"))
		}
		return b.String()
	}

	// Visible range: header(1) + count(1) + separator(1) + separator(1) + help(1) = 5
	visibleLines := m.height - 5
	if visibleLines < 5 {
		visibleLines = 5
	}
	start := 0
	if m.cursor >= visibleLines {
		start = m.cursor - visibleLines + 1
	}
	end := start + visibleLines
	if end > len(sessions) {
		end = len(sessions)
	}

	for i := start; i < end; i++ {
		s := sessions[i]
		cursor := "  "
		if i == m.cursor {
			cursor = cursorStyle.Render("\u25b6") + " "
		}

		date := s.ModTime.Format("01/02 15:04")
		project := s.Project
		id := truncateID(s.SessionID)
		sizeKB := s.Size / 1024

		line := fmt.Sprintf("%s%s  %s  %s  %dKB",
			cursor, date, userMsgStyle.Render(project), dimStyle.Render(id), sizeKB)

		if i == m.cursor {
			b.WriteString(userMsgStyle.Render(line))
		} else {
			b.WriteString(line)
		}
		b.WriteString("\n")
	}

	b.WriteString(separatorStyle.Render(strings.Repeat("\u2500", max(m.width, 40))))
	b.WriteString("\n")
	if m.searching {
		b.WriteString(helpStyle.Render("  Enter: confirm | Esc: clear search"))
	} else if m.searchQuery != "" {
		b.WriteString(helpStyle.Render("  Enter: open | /: edit search | Esc: clear | q: quit"))
	} else {
		b.WriteString(helpStyle.Render("  Enter: open | /: search | q: quit | \u2191\u2193: select"))
	}

	return b.String()
}
