package tui

import (
	"strconv"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/hir4ta/claude-alfred/internal/analyzer"
	"github.com/hir4ta/claude-alfred/internal/parser"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// Tab IDs
const (
	tabActivity  = 0
	tabDecisions = 1
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

	// Animation state
	animFrame    int  // increments every animTick (for shimmer, pulse, etc.)

	// Dashboard
	st *store.Store // nil-safe

	// Tabs
	activeTab int            // tabActivity or tabDecisions
	decisions []store.DecisionRow

	// Decision operations (Decisions tab)
	decisionInput    textinput.Model // text input for adding decisions
	addingDecision   bool            // add-decision mode active
	deletingDecision bool            // confirming deletion
	decisionCursor   int             // selected decision index
}

// NewModel creates a new TUI model with initial events pre-loaded.
// st may be nil if the store is unavailable.
func NewModel(initialEvents []parser.SessionEvent, eventCh <-chan parser.SessionEvent, sessionID string, st *store.Store) Model {
	stats := analyzer.NewStats()
	var tasks []TaskState
	taskMap := make(map[string]int)
	taskCounter := 0
	awaitingAnswer := false
	inPlanMode := false

	var events []parser.SessionEvent
	for i := range initialEvents {
		ev := &initialEvents[i]
		stats.Update(*ev)

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

	ti := textinput.New()
	ti.Placeholder = "Type a decision to remember..."
	ti.CharLimit = 300

	return Model{
		events:        events,
		stats:         stats,
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
		decisionInput: ti,
	}
}

// Messages
type newEventMsg parser.SessionEvent
type sessionEndedMsg struct{}
type tickMsg time.Time
type animTickMsg time.Time
type dbRefreshMsg []store.DecisionRow

func (m Model) Init() tea.Cmd {
	return tea.Batch(
		m.waitForEvent(),
		tickCmd(),
		animTickCmd(),
		m.dbRefreshCmd(),
	)
}

// dbRefreshCmd loads decisions from the DB every 30 seconds.
// Captures only the needed fields to avoid holding a stale copy of the full Model.
func (m Model) dbRefreshCmd() tea.Cmd {
	st := m.st
	sessionID := m.sessionID
	return tea.Tick(30*time.Second, func(_ time.Time) tea.Msg {
		if st == nil || sessionID == "" {
			return dbRefreshMsg(nil)
		}
		rows, _ := st.GetDecisions(sessionID, "", 50)
		return dbRefreshMsg(rows)
	})
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

		// Update stats and tasks
		m.stats.Update(ev)

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

	case dbRefreshMsg:
		if msg != nil {
			m.decisions = []store.DecisionRow(msg)
		}
		return m, m.dbRefreshCmd()

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
		// When in decision input/confirm mode, skip global keys to avoid accidental quit/tab switch.
		if m.addingDecision || m.deletingDecision {
			if m.activeTab == tabDecisions {
				return m.updateDecisions(msg)
			}
		}
		// Global keys (all tabs)
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "?":
			m.showHelp = true
			return m, nil
		case "1":
			m.activeTab = tabActivity
			return m, nil
		case "2":
			m.activeTab = tabDecisions
			// Trigger immediate DB refresh when switching to Decisions tab.
			if m.st != nil && m.sessionID != "" {
				rows, _ := m.st.GetDecisions(m.sessionID, "", 50)
				m.decisions = rows
			}
			return m, nil
		case "tab":
			if m.activeTab == tabActivity {
				m.activeTab = tabDecisions
				if m.st != nil && m.sessionID != "" {
					rows, _ := m.st.GetDecisions(m.sessionID, "", 50)
					m.decisions = rows
				}
			} else {
				m.activeTab = tabActivity
			}
			return m, nil
		}
		if m.activeTab == tabActivity {
			return m.updateActivity(msg)
		}
		if m.activeTab == tabDecisions {
			return m.updateDecisions(msg)
		}
		return m, nil
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
	// header: 3 lines (title + stats + summary) + tab bar
	h := 4

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


// updateDecisions handles key events for the Decisions tab.
func (m Model) updateDecisions(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// Adding mode: text input is active
	if m.addingDecision {
		switch msg.Type {
		case tea.KeyEscape:
			m.addingDecision = false
			m.decisionInput.Blur()
			m.decisionInput.SetValue("")
			return m, nil
		case tea.KeyEnter:
			text := m.decisionInput.Value()
			if text != "" && m.st != nil {
				topic := text
				if runes := []rune(topic); len(runes) > 80 {
					topic = string(runes[:80])
				}
				d := &store.DecisionRow{
					SessionID:    m.sessionID,
					Timestamp:    time.Now().UTC().Format(time.RFC3339),
					Topic:        topic,
					DecisionText: text,
					FilePaths:    "[]",
				}
				// Ignore error; best-effort insert
				_ = m.st.InsertDecision(d)
			}
			m.addingDecision = false
			m.decisionInput.Blur()
			m.decisionInput.SetValue("")
			m.refreshDecisions()
			return m, nil
		}
		var cmd tea.Cmd
		m.decisionInput, cmd = m.decisionInput.Update(msg)
		return m, cmd
	}

	// Deleting mode: confirmation prompt
	if m.deletingDecision {
		switch msg.String() {
		case "y":
			if m.decisionCursor < len(m.decisions) && m.st != nil {
				id := m.decisions[m.decisionCursor].ID
				_ = m.st.DeleteDecision(id)
				m.refreshDecisions()
				if m.decisionCursor >= len(m.decisions) && m.decisionCursor > 0 {
					m.decisionCursor--
				}
			}
			m.deletingDecision = false
			return m, nil
		case "n", "escape":
			m.deletingDecision = false
			return m, nil
		}
		return m, nil
	}

	// Normal navigation in Decisions tab
	switch msg.String() {
	case "up", "k":
		if m.decisionCursor > 0 {
			m.decisionCursor--
		}
		return m, nil
	case "down", "j":
		if m.decisionCursor < len(m.decisions)-1 {
			m.decisionCursor++
		}
		return m, nil
	case "a":
		m.addingDecision = true
		m.decisionInput.Focus()
		return m, nil
	case "d":
		if len(m.decisions) > 0 && m.decisionCursor < len(m.decisions) {
			m.deletingDecision = true
		}
		return m, nil
	}
	return m, nil
}

// refreshDecisions reloads decisions from the DB into the model.
func (m *Model) refreshDecisions() {
	if m.st != nil && m.sessionID != "" {
		rows, _ := m.st.GetDecisions(m.sessionID, "", 50)
		m.decisions = rows
	}
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


