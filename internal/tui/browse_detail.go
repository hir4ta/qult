package tui

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/hir4ta/claude-buddy/internal/parser"
)

func (m BrowseModel) updateDetail(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "esc", "backspace":
		m.viewMode = viewList
		m.detail = nil
		m.detailExpanded = nil
		m.detailExpandOffset = 0
		return m, nil
	case "up", "k":
		if m.detailExpanded[m.detailCursor] && m.detailExpandOffset > 0 {
			m.detailExpandOffset--
			return m, nil
		}
		prev := m.prevVisibleDetailIdx(m.detailCursor)
		if prev != m.detailCursor {
			m.detailCursor = prev
			m.detailExpandOffset = 0
		}
	case "down", "j":
		if m.detailExpanded[m.detailCursor] && m.detail != nil {
			maxOff := m.detailExpandMaxOffset()
			if m.detailExpandOffset < maxOff {
				m.detailExpandOffset++
				return m, nil
			}
		}
		next := m.nextVisibleDetailIdx(m.detailCursor)
		if next != m.detailCursor {
			m.detailCursor = next
			m.detailExpandOffset = 0
		}
	case "enter":
		if m.detailExpanded != nil {
			if m.detailExpanded[m.detailCursor] {
				delete(m.detailExpanded, m.detailCursor)
			} else {
				m.detailExpanded[m.detailCursor] = true
			}
			m.detailExpandOffset = 0
		}
	case "home", "g":
		m.detailCursor = m.firstVisibleDetailIdx()
		m.detailExpandOffset = 0
	case "end", "G":
		m.detailCursor = m.lastVisibleDetailIdx()
		m.detailExpandOffset = 0
	}
	return m, nil
}

// detailFixedHeight returns lines consumed by non-event areas.
func (m BrowseModel) detailFixedHeight() int {
	// header: 1, stats: 1, separator: 1, separator: 1, help: 1 = 5
	h := 5
	if m.detail != nil && len(m.detail.Stats.ToolFreq) > 0 {
		h++ // tool frequency line
	}
	return h
}

// detailAreaHeight returns available lines for the event list.
func (m BrowseModel) detailAreaHeight() int {
	h := m.height - m.detailFixedHeight()
	if h < 5 {
		h = 5
	}
	return h
}

// detailExpandMaxOffset returns max scroll offset within expanded text.
func (m BrowseModel) detailExpandMaxOffset() int {
	if m.detail == nil || m.detailCursor < 0 || m.detailCursor >= len(m.detail.Events) {
		return 0
	}
	ev := m.detail.Events[m.detailCursor]
	fullText := eventFullText(ev)
	if fullText == "" {
		return 0
	}
	cw := m.width - 6 - 4 // 4 = border overhead
	if cw < 30 {
		cw = 30
	}
	rendered := renderMarkdown(fullText, cw)
	totalLines := len(rendered)

	if ev.Type == parser.EventAssistantText {
		for _, tev := range collectToolEvents(m.detail.Events, m.detailCursor) {
			if formatToolSummary(tev) != "" {
				totalLines++
			}
		}
	}

	maxOff := totalLines - (m.detailAreaHeight() - 1)
	if maxOff < 0 {
		return 0
	}
	return maxOff
}

// Browse detail visible-event navigation helpers.

func (m BrowseModel) nextVisibleDetailIdx(idx int) int {
	if m.detail == nil {
		return idx
	}
	for i := idx + 1; i < len(m.detail.Events); i++ {
		if isVisibleEvent(m.detail.Events[i]) {
			return i
		}
	}
	return idx
}

func (m BrowseModel) prevVisibleDetailIdx(idx int) int {
	if m.detail == nil {
		return idx
	}
	for i := idx - 1; i >= 0; i-- {
		if isVisibleEvent(m.detail.Events[i]) {
			return i
		}
	}
	return idx
}

func (m BrowseModel) lastVisibleDetailIdx() int {
	if m.detail == nil {
		return 0
	}
	for i := len(m.detail.Events) - 1; i >= 0; i-- {
		if isVisibleEvent(m.detail.Events[i]) {
			return i
		}
	}
	return 0
}

func (m BrowseModel) firstVisibleDetailIdx() int {
	if m.detail == nil {
		return 0
	}
	for i := 0; i < len(m.detail.Events); i++ {
		if isVisibleEvent(m.detail.Events[i]) {
			return i
		}
	}
	return 0
}

func (m BrowseModel) viewDetail() string {
	if m.detail == nil {
		return dimStyle.Render("Loading...")
	}

	var b strings.Builder
	d := m.detail

	// Header
	b.WriteString(headerStyle.Render(fmt.Sprintf(" Session: %s ", truncateID(d.Info.SessionID))))
	b.WriteString("  ")
	b.WriteString(dimStyle.Render(d.Info.Project))
	b.WriteString("\n")

	// Stats
	elapsed := time.Duration(0)
	if !d.Stats.FirstTime.IsZero() && !d.Stats.LastTime.IsZero() {
		elapsed = d.Stats.LastTime.Sub(d.Stats.FirstTime)
	}
	b.WriteString(statsStyle.Render(fmt.Sprintf(
		"Turns: %d | Tools: %d | %dmin | %s",
		d.Stats.TurnCount, d.Stats.ToolUseCount,
		int(elapsed.Minutes()),
		d.Info.ModTime.Format("2006-01-02 15:04"),
	)))
	b.WriteString("\n")

	// Tool frequency
	if len(d.Stats.ToolFreq) > 0 {
		var toolParts []string
		for name, count := range d.Stats.ToolFreq {
			toolParts = append(toolParts, fmt.Sprintf("%s(%d)", name, count))
		}
		b.WriteString(dimStyle.Render("Tools: " + strings.Join(toolParts, " ")))
		b.WriteString("\n")
	}

	b.WriteString(separatorStyle.Render(strings.Repeat("\u2500", max(m.width, 40))))
	b.WriteString("\n")

	// Build viewlines with cursor + expand
	borderOverhead := 4
	contentWidth := m.width - 6 - borderOverhead
	if contentWidth < 30 {
		contentWidth = 30
	}

	var lines []viewLine
	for i, ev := range d.Events {
		if !isVisibleEvent(ev) {
			continue
		}
		line := formatEvent(ev)
		if line == "" {
			continue
		}
		isCursor := i == m.detailCursor
		lines = append(lines, viewLine{text: line, isCursor: isCursor})

		if m.detailExpanded[i] {
			fullText := eventFullText(ev)
			if fullText != "" {
				rendered := renderMarkdown(fullText, contentWidth)
				startIdx := 0
				if i == m.detailCursor && m.detailExpandOffset > 0 {
					startIdx = m.detailExpandOffset
					if startIdx > len(rendered) {
						startIdx = len(rendered)
					}
				}
				for _, rl := range rendered[startIdx:] {
					lines = append(lines, viewLine{
						text:       rl,
						isExpanded: true,
					})
				}
			}

			if ev.Type == parser.EventAssistantText {
				tools := collectToolEvents(d.Events, i)
				for _, tev := range tools {
					summary := formatToolSummary(tev)
					if summary != "" {
						lines = append(lines, viewLine{
							text:       summary,
							isExpanded: true,
						})
					}
				}
			}
		}
	}

	availableLines := m.detailAreaHeight()

	if len(lines) > 0 {
		cursorLine := 0
		for i, l := range lines {
			if l.isCursor {
				cursorLine = i
				break
			}
		}

		var start int
		if m.detailExpanded[m.detailCursor] {
			start = cursorLine
		} else {
			start = cursorLine - availableLines/2
		}
		if start < 0 {
			start = 0
		}
		end := start + availableLines
		if end > len(lines) {
			end = len(lines)
			start = end - availableLines
			if start < 0 {
				start = 0
			}
		}

		visible := lines[start:end]
		vi := 0
		for vi < len(visible) {
			l := visible[vi]

			if l.isExpanded {
				var block []string
				for vi < len(visible) && visible[vi].isExpanded {
					block = append(block, visible[vi].text)
					vi++
				}
				boxContent := strings.Join(block, "\n")
				box := expandedBoxStyle.Width(contentWidth + 2).Render(boxContent)
				for _, boxLine := range strings.Split(box, "\n") {
					b.WriteString("      " + boxLine)
					b.WriteString("\n")
				}
				continue
			}

			text := l.text
			if l.isCursor && len(text) >= 2 && text[:2] == "  " {
				text = cursorStyle.Render("\u25b6") + " " + text[2:]
			}
			b.WriteString(text)
			b.WriteString("\n")
			vi++
		}
	} else {
		b.WriteString(dimStyle.Render("  No events"))
		b.WriteString("\n")
	}

	b.WriteString(separatorStyle.Render(strings.Repeat("\u2500", max(m.width, 40))))
	b.WriteString("\n")
	b.WriteString(helpStyle.Render("  esc: back | q: quit | \u2191\u2193: select | Enter: expand/collapse"))

	return b.String()
}
