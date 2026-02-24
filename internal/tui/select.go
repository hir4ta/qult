package tui

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

// SelectModel is a Bubble Tea model for interactive session selection.
type SelectModel struct {
	sessions []watcher.RecentSession
	cursor   int
	selected int // -1 = no selection yet
	width    int
	height   int
	lang     locale.Lang
}

// NewSelectModel creates a session selector model.
func NewSelectModel(sessions []watcher.RecentSession, lang locale.Lang) SelectModel {
	return SelectModel{
		sessions: sessions,
		selected: -1,
		lang:     lang,
	}
}

// Selected returns the index of the selected session, or -1 if cancelled.
func (m SelectModel) Selected() int {
	return m.selected
}

func (m SelectModel) Init() tea.Cmd {
	return nil
}

func (m SelectModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			m.selected = -1
			return m, tea.Quit
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < len(m.sessions)-1 {
				m.cursor++
			}
		case "enter":
			m.selected = m.cursor
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m SelectModel) View() string {
	var b strings.Builder

	b.WriteString(headerStyle.Render(" claude-buddy "))
	b.WriteString("  ")
	b.WriteString(dimStyle.Render("Select a session to watch"))
	b.WriteString("\n")
	b.WriteString(separatorStyle.Render(strings.Repeat("\u2500", clampWidth(m.width))))
	b.WriteString("\n")

	if len(m.sessions) == 0 {
		b.WriteString(dimStyle.Render("  No sessions found"))
		return b.String()
	}

	// Scrollable range
	visible := m.height - 4 // header + separator + separator + help
	if visible < 5 {
		visible = 5
	}
	start := 0
	if m.cursor >= visible {
		start = m.cursor - visible + 1
	}
	end := start + visible
	if end > len(m.sessions) {
		end = len(m.sessions)
	}

	// Compute max project name width for alignment
	maxProj := 0
	for i := start; i < end; i++ {
		if l := len([]rune(m.sessions[i].Project)); l > maxProj {
			maxProj = l
		}
	}

	for i := start; i < end; i++ {
		s := m.sessions[i]

		cursor := "  "
		if i == m.cursor {
			cursor = cursorStyle.Render("\u25b6") + " "
		}

		sid := s.SessionID
		if len(sid) > 8 {
			sid = sid[:8]
		}

		age := humanizeAge(time.Since(s.ModTime))

		project := s.Project
		pad := maxProj - len([]rune(project))
		if pad > 0 {
			project += strings.Repeat(" ", pad)
		}

		prompt := ""
		if s.FirstPrompt != "" {
			prompt = dimStyle.Render(fmt.Sprintf(" \u300c%s\u300d", s.FirstPrompt))
		}

		line := fmt.Sprintf("%s%s  %s  %s%s",
			cursor,
			dimStyle.Render(sid),
			userMsgStyle.Render(project),
			statsStyle.Render(fmt.Sprintf("%-9s", age)),
			prompt,
		)

		b.WriteString(line)
		b.WriteString("\n")
	}

	b.WriteString(separatorStyle.Render(strings.Repeat("\u2500", clampWidth(m.width))))
	b.WriteString("\n")
	b.WriteString(helpStyle.Render("  Enter: select | q: quit | \u2191\u2193: navigate"))

	return b.String()
}

func clampWidth(w int) int {
	if w < 40 {
		return 40
	}
	return w
}
