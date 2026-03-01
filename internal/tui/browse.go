package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/hir4ta/claude-alfred/internal/watcher"
)

// BrowseModel is the Bubble Tea model for session browsing.
type BrowseModel struct {
	sessions           []watcher.SessionInfo
	filtered           []int // indices into sessions (nil = no filter)
	cursor             int
	detail             *watcher.SessionDetail
	viewMode           browseView // list or detail
	detailCursor       int
	detailExpanded     map[int]bool
	detailExpandOffset int
	width              int
	height             int
	err                error
	// Search
	searching   bool
	searchQuery string
}

type browseView int

const (
	viewList browseView = iota
	viewDetail
)

type sessionLoadedMsg struct {
	detail *watcher.SessionDetail
	err    error
}

// NewBrowseModel creates a browse mode model.
func NewBrowseModel(sessions []watcher.SessionInfo) BrowseModel {
	return BrowseModel{
		sessions: sessions,
		viewMode: viewList,
	}
}

func (m BrowseModel) Init() tea.Cmd {
	return nil
}

func (m BrowseModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case sessionLoadedMsg:
		m.detail = msg.detail
		m.err = msg.err
		if m.err == nil {
			m.viewMode = viewDetail
			m.detailExpanded = make(map[int]bool)
			m.detailExpandOffset = 0
			m.detailCursor = m.lastVisibleDetailIdx()
		}
		return m, nil

	case tea.KeyMsg:
		switch m.viewMode {
		case viewList:
			return m.updateList(msg)
		case viewDetail:
			return m.updateDetail(msg)
		}
	}
	return m, nil
}

func (m BrowseModel) View() string {
	switch m.viewMode {
	case viewDetail:
		return m.viewDetail()
	default:
		return m.viewList()
	}
}

// visibleSessions returns the list of sessions to display (filtered or all).
func (m BrowseModel) visibleSessions() []watcher.SessionInfo {
	if m.filtered == nil {
		return m.sessions
	}
	result := make([]watcher.SessionInfo, len(m.filtered))
	for i, idx := range m.filtered {
		result[i] = m.sessions[idx]
	}
	return result
}

// visibleCount returns how many sessions are currently visible.
func (m BrowseModel) visibleCount() int {
	if m.filtered == nil {
		return len(m.sessions)
	}
	return len(m.filtered)
}

// applyFilter updates filtered indices based on searchQuery.
func (m *BrowseModel) applyFilter() {
	if m.searchQuery == "" {
		m.filtered = nil
		return
	}
	query := strings.ToLower(m.searchQuery)
	var indices []int
	for i, s := range m.sessions {
		if strings.Contains(strings.ToLower(s.Project), query) ||
			strings.Contains(strings.ToLower(s.SessionID), query) {
			indices = append(indices, i)
		}
	}
	m.filtered = indices
	if m.cursor >= len(indices) {
		m.cursor = len(indices) - 1
		if m.cursor < 0 {
			m.cursor = 0
		}
	}
}
