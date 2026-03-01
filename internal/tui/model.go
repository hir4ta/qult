package tui

import (
	"strconv"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/hir4ta/claude-alfred/internal/analyzer"
	"github.com/hir4ta/claude-alfred/internal/parser"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// Tab represents a dashboard tab.
type Tab int

const (
	TabActivity    Tab = iota
	TabKnowledge
	TabPreferences
	TabDocs
)

// TaskState tracks a single task's current state.
type TaskState struct {
	ID         string
	Subject    string
	Status     string // "pending", "in_progress", "completed"
	ActiveForm string
	Owner      string
}

// Model is the Bubble Tea model for the watch TUI.
type Model struct {
	events         []parser.SessionEvent
	stats          analyzer.Stats
	detector       *analyzer.Detector
	tasks          []TaskState // ordered by creation
	taskMap        map[string]int // taskID -> index in tasks
	taskCounter    int
	sessionID      string
	eventCh        <-chan parser.SessionEvent
	width          int
	height         int
	ready          bool
	cursorIdx      int          // selected event index
	expanded       map[int]bool // event indices that are expanded
	expandOffset   int          // scroll offset within expanded text
	autoFollow     bool         // cursor follows new events
	inPlanMode     bool
	awaitingAnswer bool // next user message is an AskUserQuestion response
	sessionEnded   bool   // event channel closed
	showHelp       bool   // help overlay visible

	// Usage score
	scoreCalc *analyzer.ScoreCalculator

	// Animation state
	animFrame    int  // increments every animTick (for shimmer, pulse, etc.)

	// Dashboard tabs
	activeTab Tab
	st        *store.Store // nil-safe

	// Knowledge tab cache
	knTotal     int
	knBySource  map[string]int
	knLastCrawl string
	knVersion   string

	// Preferences tab cache
	pfCluster  string
	pfMetrics  []store.UserProfileMetric
	pfFeatures map[string]*store.UserPref

	// Docs tab state
	docsSearching bool
	docsQuery     string
	docsResults   []store.DocRow
	docsCursor    int
	docsExpanded  map[int]bool
	docsScrollOff int
}

// NewModel creates a new TUI model with initial events pre-loaded.
// st may be nil if the store is unavailable.
func NewModel(initialEvents []parser.SessionEvent, eventCh <-chan parser.SessionEvent, sessionID string, st *store.Store) Model {
	stats := analyzer.NewStats()
	det := analyzer.NewDetector()
	sc := analyzer.NewScoreCalculator()
	var tasks []TaskState
	taskMap := make(map[string]int)
	taskCounter := 0
	awaitingAnswer := false
	inPlanMode := false

	var events []parser.SessionEvent
	for i := range initialEvents {
		ev := &initialEvents[i]
		stats.Update(*ev)
		initAlerts := det.Update(*ev)
		sc.Update(*ev, initAlerts)

		// Auto-compact boundary: reset displayed events to avoid duplicates.
		// After compaction, Claude Code re-serializes context messages to the JSONL,
		// so we only show events from the latest segment.
		if ev.Type == parser.EventCompactBoundary {
			events = events[:0]
			tasks = tasks[:0]
			taskMap = make(map[string]int)
			taskCounter = 0
			inPlanMode = false
			awaitingAnswer = false
			continue
		}

		// Deduplicate TaskUpdate events from repeated TaskList calls:
		// skip if the task already exists with the same status.
		if ev.Type == parser.EventTaskUpdate && ev.TaskID != "" {
			if idx, ok := taskMap[ev.TaskID]; ok && idx < len(tasks) {
				if tasks[idx].Status == ev.TaskStatus {
					updateTasks(*ev, &tasks, taskMap, &taskCounter)
					applyModeFlags(ev, &inPlanMode, &awaitingAnswer)
					continue
				}
			}
		}

		updateTasks(*ev, &tasks, taskMap, &taskCounter)
		applyModeFlags(ev, &inPlanMode, &awaitingAnswer)
		events = append(events, *ev)
	}

	// Find last visible event index for initial cursor
	cursorIdx := 0
	for i := len(events) - 1; i >= 0; i-- {
		if isVisibleEvent(events[i]) {
			cursorIdx = i
			break
		}
	}

	return Model{
		events:        events,
		stats:         stats,
		detector:      det,
		scoreCalc:     sc,
		tasks:         tasks,
		taskMap:       taskMap,
		taskCounter:   taskCounter,
		eventCh:       eventCh,
		sessionID:     sessionID,
		cursorIdx:     cursorIdx,
		expanded:      make(map[int]bool),
		autoFollow:    true,
		inPlanMode:    inPlanMode,
		awaitingAnswer: awaitingAnswer,
		st:            st,
		docsExpanded:  make(map[int]bool),
	}
}

// Messages
type newEventMsg parser.SessionEvent
type sessionEndedMsg struct{}
type tickMsg time.Time
type animTickMsg time.Time

func (m Model) Init() tea.Cmd {
	return tea.Batch(
		m.waitForEvent(),
		tickCmd(),
		animTickCmd(),
	)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.ready = true
		return m, nil

	case sessionEndedMsg:
		m.sessionEnded = true
		return m, nil

	case newEventMsg:
		ev := parser.SessionEvent(msg)
		applyModeFlags(&ev, &m.inPlanMode, &m.awaitingAnswer)

		// Update stats, detector, and tasks always
		m.stats.Update(ev)
		newAlerts := m.detector.Update(ev)
		m.scoreCalc.Update(ev, newAlerts)

		// Auto-compact boundary: reset displayed events to avoid duplicates.
		if ev.Type == parser.EventCompactBoundary {
			m.events = m.events[:0]
			m.tasks = m.tasks[:0]
			m.taskMap = make(map[string]int)
			m.taskCounter = 0
			m.expanded = make(map[int]bool)
			m.cursorIdx = 0
			m.expandOffset = 0
			return m, m.waitForEvent()
		}

		// Deduplicate TaskUpdate events from repeated TaskList calls:
		// skip display if the task already exists with the same status.
		if ev.Type == parser.EventTaskUpdate && ev.TaskID != "" {
			if idx, ok := m.taskMap[ev.TaskID]; ok && idx < len(m.tasks) {
				if m.tasks[idx].Status == ev.TaskStatus {
					updateTasks(ev, &m.tasks, m.taskMap, &m.taskCounter)
					return m, m.waitForEvent()
				}
			}
		}

		updateTasks(ev, &m.tasks, m.taskMap, &m.taskCounter)
		m.events = append(m.events, ev)

		// Auto-follow: move cursor to latest visible event
		if m.autoFollow {
			m.cursorIdx = m.lastVisibleIdx()
		}

		return m, m.waitForEvent()

	case animTickMsg:
		m.animFrame++
		return m, animTickCmd()

	case tickMsg:
		// Periodic refresh for elapsed time display
		return m, tickCmd()

	case tea.KeyMsg:
		if m.showHelp {
			m.showHelp = false
			return m, nil
		}
		// Global keys (all tabs)
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "?":
			m.showHelp = true
			return m, nil
		case "1":
			m.switchTab(TabActivity)
			return m, nil
		case "2":
			m.switchTab(TabKnowledge)
			return m, nil
		case "3":
			m.switchTab(TabPreferences)
			return m, nil
		case "4":
			m.switchTab(TabDocs)
			return m, nil
		case "tab":
			next := (m.activeTab + 1) % 4
			m.switchTab(next)
			return m, nil
		case "shift+tab":
			next := (m.activeTab + 3) % 4
			m.switchTab(next)
			return m, nil
		}
		// Tab-specific keys
		switch m.activeTab {
		case TabDocs:
			return m.updateDocs(msg)
		case TabActivity:
			return m.updateActivity(msg)
		}
	}

	return m, nil
}

// waitForEvent returns a Cmd that waits for the next event from the channel.
func (m Model) waitForEvent() tea.Cmd {
	return func() tea.Msg {
		ev, ok := <-m.eventCh
		if !ok {
			return sessionEndedMsg{}
		}
		return newEventMsg(ev)
	}
}

// updateTasks tracks task state from TaskCreate/TaskUpdate events.
func updateTasks(ev parser.SessionEvent, tasks *[]TaskState, taskMap map[string]int, counter *int) {
	switch ev.Type {
	case parser.EventTaskCreate:
		*counter++
		id := strconv.Itoa(*counter)
		taskMap[id] = len(*tasks)
		*tasks = append(*tasks, TaskState{
			ID:         id,
			Subject:    ev.TaskSubject,
			Status:     "pending",
			ActiveForm: ev.TaskActiveForm,
		})
	case parser.EventTaskUpdate:
		idx, ok := taskMap[ev.TaskID]
		if !ok || idx >= len(*tasks) {
			// TaskUpdate arrived before TaskCreate; create a placeholder.
			idx = len(*tasks)
			taskMap[ev.TaskID] = idx
			*tasks = append(*tasks, TaskState{
				ID:     ev.TaskID,
				Status: "pending",
			})
			// Sync counter to avoid ID collision with future TaskCreate events.
			if n, err := strconv.Atoi(ev.TaskID); err == nil && n > *counter {
				*counter = n
			}
		}
		if ev.TaskStatus != "" {
			(*tasks)[idx].Status = ev.TaskStatus
		}
		if ev.TaskSubject != "" {
			(*tasks)[idx].Subject = ev.TaskSubject
		}
		if ev.TaskActiveForm != "" {
			(*tasks)[idx].ActiveForm = ev.TaskActiveForm
		}
	}
}

// applyModeFlags updates plan mode and awaiting-answer state based on tool_use events.
func applyModeFlags(ev *parser.SessionEvent, inPlanMode *bool, awaitingAnswer *bool) {
	switch ev.Type {
	case parser.EventToolUse:
		switch ev.ToolName {
		case "EnterPlanMode":
			*inPlanMode = true
		case "ExitPlanMode":
			*inPlanMode = false
		case "AskUserQuestion":
			*awaitingAnswer = true
		}
	case parser.EventUserMessage:
		if *awaitingAnswer {
			*awaitingAnswer = false
			// Parser may already set IsAnswer for tool_result answers;
			// also set it here for regular text answers.
			ev.IsAnswer = true
		}
	case parser.EventPlanApproval:
		// Plan approval comes from ExitPlanMode tool_result; reset awaiting state.
		*awaitingAnswer = false
	}
}

// fixedHeight returns the number of lines consumed by non-message areas.
func (m Model) fixedHeight() int {
	// header: 3 lines (title + stats + score) + tab bar + optional breakdown line
	h := 4
	score := m.scoreCalc.Score()
	bd := score.Components
	if bd.AlertPenalty != 0 || bd.ToolEfficiency != 0 || bd.PlanMode != 0 ||
		bd.CLAUDEMD != 0 || bd.Subagent != 0 || bd.ContextMgmt != 0 || bd.InstructionQual != 0 {
		h++ // breakdown line
	}

	// tasks section
	taskCount := 0
	for _, t := range m.tasks {
		if t.Status != "deleted" {
			taskCount++
		}
	}
	if taskCount > 0 {
		h++ // ─── Tasks ─── separator
		h += taskCount
	}

	// ─── Monitor ─── separator: 1
	h++

	// bottom separator: 1
	h++

	// session ended line (optional): 1
	if m.sessionEnded {
		h++
	}

	// help line: 1
	h++

	return h
}

// msgAreaHeight returns the number of lines available for the message area.
func (m Model) msgAreaHeight() int {
	h := m.height - m.fixedHeight()
	if h < 3 {
		h = 3
	}
	return h
}

// expandMaxOffset returns how far the user can scroll within expanded text.
func (m Model) expandMaxOffset(eventIdx int) int {
	if eventIdx < 0 || eventIdx >= len(m.events) {
		return 0
	}
	fullText := eventFullText(m.events[eventIdx])
	if fullText == "" {
		return 0
	}
	cw := m.width - 6 - 4
	if cw < 30 {
		cw = 30
	}
	rendered := renderMarkdown(fullText, cw)
	totalLines := len(rendered)

	// Add tool summary lines for assistant events
	if m.events[eventIdx].Type == parser.EventAssistantText {
		for _, tev := range collectToolEvents(m.events, eventIdx) {
			if formatToolSummary(tev) != "" {
				totalLines++
			}
		}
	}

	maxOff := totalLines - (m.msgAreaHeight() - 3) // 1 cursor line + 2 box border lines
	if maxOff < 0 {
		return 0
	}
	return maxOff
}

// nextVisibleIdx returns the next event index that is visible in the event list.
func (m Model) nextVisibleIdx(idx int) int {
	for i := idx + 1; i < len(m.events); i++ {
		if isVisibleEvent(m.events[i]) {
			return i
		}
	}
	return idx // stay in place if no next visible
}

// prevVisibleIdx returns the previous event index that is visible in the event list.
func (m Model) prevVisibleIdx(idx int) int {
	for i := idx - 1; i >= 0; i-- {
		if isVisibleEvent(m.events[i]) {
			return i
		}
	}
	return idx // stay in place if no prev visible
}

// lastVisibleIdx returns the last visible event index.
func (m Model) lastVisibleIdx() int {
	for i := len(m.events) - 1; i >= 0; i-- {
		if isVisibleEvent(m.events[i]) {
			return i
		}
	}
	return 0
}

// firstVisibleIdx returns the first visible event index.
func (m Model) firstVisibleIdx() int {
	for i := 0; i < len(m.events); i++ {
		if isVisibleEvent(m.events[i]) {
			return i
		}
	}
	return 0
}

func tickCmd() tea.Cmd {
	return tea.Tick(5*time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func animTickCmd() tea.Cmd {
	return tea.Tick(150*time.Millisecond, func(t time.Time) tea.Msg {
		return animTickMsg(t)
	})
}

// switchTab changes the active tab and refreshes data if needed.
func (m *Model) switchTab(tab Tab) {
	m.activeTab = tab
	switch tab {
	case TabKnowledge:
		m.refreshKnowledge()
	case TabPreferences:
		m.refreshPreferences()
	}
}

// refreshKnowledge loads docs statistics from the store.
func (m *Model) refreshKnowledge() {
	if m.st == nil {
		return
	}
	total, bySource, lastCrawl, err := m.st.DocsStats()
	if err != nil {
		return
	}
	m.knTotal = total
	m.knBySource = bySource
	m.knLastCrawl = lastCrawl
	m.knVersion, _, _ = m.st.LatestChangelogVersion()
}

// refreshPreferences loads user profile data from the store.
func (m *Model) refreshPreferences() {
	if m.st == nil {
		return
	}
	m.pfCluster = m.st.UserCluster()
	m.pfMetrics, _ = m.st.AllUserProfile()
	m.pfFeatures = make(map[string]*store.UserPref)
	for _, key := range []string{"plan_mode", "worktree", "agent", "skill", "team"} {
		if p, err := m.st.UserPreference("feature_" + key); err == nil && p != nil {
			m.pfFeatures[key] = p
		}
	}
}

// executeDocsSearch runs a docs search with FTS5 → LIKE fallback.
func (m *Model) executeDocsSearch() {
	if m.st == nil || m.docsQuery == "" {
		m.docsResults = nil
		return
	}
	results, err := m.st.SearchDocsFTS(m.docsQuery, "", 20)
	if err != nil || len(results) == 0 {
		results, _ = m.st.SearchDocsLIKE(m.docsQuery, 20)
	}
	m.docsResults = results
	m.docsCursor = 0
	m.docsExpanded = make(map[int]bool)
}

// updateActivity handles key events for the Activity tab.
func (m Model) updateActivity(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		if m.expanded[m.cursorIdx] && m.expandOffset > 0 {
			m.expandOffset--
			return m, nil
		}
		prev := m.prevVisibleIdx(m.cursorIdx)
		if prev != m.cursorIdx {
			m.cursorIdx = prev
			m.expandOffset = 0
			m.autoFollow = false
		}
		return m, nil
	case "down", "j":
		if m.expanded[m.cursorIdx] && m.cursorIdx < len(m.events) {
			maxOff := m.expandMaxOffset(m.cursorIdx)
			if m.expandOffset < maxOff {
				m.expandOffset++
				return m, nil
			}
		}
		next := m.nextVisibleIdx(m.cursorIdx)
		if next != m.cursorIdx {
			m.cursorIdx = next
			m.expandOffset = 0
		}
		if m.cursorIdx >= m.lastVisibleIdx() {
			m.autoFollow = true
		}
		return m, nil
	case "enter":
		if m.cursorIdx >= 0 && m.cursorIdx < len(m.events) {
			if m.expanded[m.cursorIdx] {
				delete(m.expanded, m.cursorIdx)
			} else {
				m.expanded[m.cursorIdx] = true
			}
			m.expandOffset = 0
		}
		return m, nil
	case "home", "g":
		m.cursorIdx = m.firstVisibleIdx()
		m.expandOffset = 0
		m.autoFollow = false
		return m, nil
	case "end", "G":
		m.cursorIdx = m.lastVisibleIdx()
		m.expandOffset = 0
		m.autoFollow = true
		return m, nil
	}
	return m, nil
}

// updateDocs handles key events for the Docs tab.
func (m Model) updateDocs(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.docsSearching {
		switch msg.String() {
		case "enter":
			m.docsSearching = false
			m.executeDocsSearch()
			return m, nil
		case "esc":
			m.docsSearching = false
			return m, nil
		case "backspace":
			if len(m.docsQuery) > 0 {
				m.docsQuery = m.docsQuery[:len(m.docsQuery)-1]
			}
			return m, nil
		default:
			if len(msg.String()) == 1 {
				m.docsQuery += msg.String()
			}
			return m, nil
		}
	}

	switch msg.String() {
	case "/":
		m.docsSearching = true
		m.docsQuery = ""
		return m, nil
	case "up", "k":
		if m.docsCursor > 0 {
			m.docsCursor--
		}
		return m, nil
	case "down", "j":
		if m.docsCursor < len(m.docsResults)-1 {
			m.docsCursor++
		}
		return m, nil
	case "enter":
		if m.docsCursor >= 0 && m.docsCursor < len(m.docsResults) {
			if m.docsExpanded[m.docsCursor] {
				delete(m.docsExpanded, m.docsCursor)
			} else {
				m.docsExpanded[m.docsCursor] = true
			}
		}
		return m, nil
	}
	return m, nil
}

