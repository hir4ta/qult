// Package tui implements the alfred dashboard using bubbletea v2.
package tui

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"os"
	"regexp"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/list"
	"charm.land/bubbles/v2/progress"
	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/table"
	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/textinput"
	"charm.land/bubbles/v2/viewport"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/glamour"
	"github.com/sergi/go-diff/diffmatchpatch"

	"github.com/hir4ta/claude-alfred/internal/spec"
)

const (
	tabTasks     = 0
	tabKnowledge = 1
	tabActivity  = 2
	tabCount     = 3
)

var tabNames = [tabCount]string{"Tasks", "Knowledge", "Activity"}

// specTaskGroup groups spec files by task for the Specs tab.
type specTaskGroup struct {
	Slug      string
	FileCount int
	TotalSize int64
	Files     []SpecEntry
}

// tickMsg triggers periodic data refresh.
type tickMsg time.Time

// searchResultMsg carries async semantic search results.
type searchResultMsg []KnowledgeEntry

// debounceTickMsg triggers a debounced search after typing pauses.
type debounceTickMsg struct{ seq int }

// dataLoadedMsg carries refreshed data from async loading.
type dataLoadedMsg struct {
	activeSlug string
	allTasks   []TaskDetail
	specs      []SpecEntry
	knowledge  []KnowledgeEntry
	activity   []ActivityEntry
	knStats    KnowledgeStats
	epics      []EpicSummary
	decisions  []DecisionEntry
	specGroups []specTaskGroup
}

// Model is the root bubbletea model.
type Model struct {
	ds      DataSource
	version string
	width   int
	height  int

	// Tab state.
	activeTab int
	showHelp  bool

	// Bubbles components.
	viewport    viewport.Model
	helpModel   help.Model
	spinner     spinner.Model
	searchInput textinput.Model
	progress    progress.Model

	// Overlay (floating window) state.
	overlayActive  bool
	overlayTitle   string
	overlayVP      viewport.Model
	overlayRawMD   string   // raw markdown content for clipboard copy
	breadcrumbs    []string // navigation path shown in overlay header
	overlayCopied  bool     // flash "Copied!" message

	// Review mode state (within Specs overlay).
	reviewMode      bool              // true when reviewing a spec file
	reviewFile      string            // which file is being reviewed (e.g. "design.md")
	reviewTaskSlug  string            // which task's spec
	reviewLines     []string          // raw lines of the file
	reviewCursor    int               // current line (0-based)
	reviewComments  map[int]string    // line number → comment body (pending)
	reviewInput     textarea.Model    // multi-line comment input
	reviewInputLine int               // which line the input is for
	reviewEditing   bool              // true when typing a comment
	reviewRounds    []spec.Review     // all review rounds for the current task
	reviewRoundIdx  int               // current round index (len-1 = latest)

	// Data caches.
	activeSlug string
	allTasks   []TaskDetail
	specs      []SpecEntry
	knowledge  []KnowledgeEntry
	activity   []ActivityEntry

	// Tasks tab state.
	taskCursor int
	taskLevel  int // 0=task list, 1=spec files for selected task

	// Specs tab state (used in drill-down from Tasks).
	specGroups      []specTaskGroup
	specGroupCursor int
	specFileCursor  int
	specLevel       int // 0=groups, 1=files

	// Knowledge tab state.
	knList      list.Model
	knStats     KnowledgeStats
	promotions  []KnowledgeEntry
	decisions   []DecisionEntry
	searchBusy  bool

	// Activity tab state.
	activityTable table.Model
	epics         []EpicSummary

	// Markdown renderer.
	mdRenderer *glamour.TermRenderer

	// Shimmer animation frame counter.
	shimmerFrame int

	// Debounce sequence for live search.
	debounceSeq int

	// Review confirmation state.
	reviewConfirmPending bool
	reviewConfirmStatus  spec.ReviewStatus
}

// New creates a new dashboard Model with version string for the title bar.
func New(ds DataSource, version string) Model {
	sp := spinner.New(
		spinner.WithSpinner(spinner.Dot),
		spinner.WithStyle(lipgloss.NewStyle().Foreground(aqua)),
	)
	h := help.New()
	h.Styles = help.DefaultStyles(true)
	ti := textinput.New()
	ti.Placeholder = "semantic search..."
	ti.CharLimit = 200
	prog := progress.New(
		progress.WithColors(aqua, lipgloss.Color("#333")),
		progress.WithoutPercentage(),
		progress.WithWidth(20),
		progress.WithFillCharacters('#', '-'),
	)
	knl := newKnowledgeList(80, 20) // sized later in WindowSizeMsg

	// Activity timeline table — non-interactive (Blur), styled header.
	// Selected must exactly match Cell so cursor row doesn't shift.
	cellStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#c0bab0")).Padding(0, 1)
	tblStyles := table.Styles{
		Header:   lipgloss.NewStyle().Bold(true).Foreground(gold).Padding(0, 1),
		Cell:     cellStyle,
		Selected: cellStyle,
	}
	actTbl := table.New(
		table.WithColumns([]table.Column{
			{Title: "Time", Width: 6},
			{Title: "Action", Width: 12},
			{Title: "Target", Width: 24},
			{Title: "Detail", Width: 36},
		}),
		table.WithHeight(10),
		table.WithStyles(tblStyles),
	)
	actTbl.Blur() // read-only, no cursor highlight

	return Model{
		ds:            ds,
		version:       version,
		helpModel:     h,
		spinner:       sp,
		searchInput:   ti,
		progress:      prog,
		knList:        knl,
		activityTable: actTbl,
	}
}

// loadDataCmd returns a tea.Cmd that loads data asynchronously in a goroutine.
// All I/O (DB queries, file reads) happens off the UI thread with a 4s timeout.
func (m *Model) loadDataCmd() tea.Cmd {
	ds := m.ds
	_ = m.searchBusy // kept for future semantic search
	return func() tea.Msg {
		done := make(chan dataLoadedMsg, 1)
		go func() {
			var msg dataLoadedMsg
			msg.activeSlug = ds.ActiveTask()
			msg.allTasks = ds.TaskDetails()

			// Build spec groups.
			specs := ds.Specs()
			msg.specs = specs
			groupMap := make(map[string]*specTaskGroup)
			var groupOrder []string
			for _, s := range specs {
				g, ok := groupMap[s.TaskSlug]
				if !ok {
					g = &specTaskGroup{Slug: s.TaskSlug}
					groupMap[s.TaskSlug] = g
					groupOrder = append(groupOrder, s.TaskSlug)
				}
				g.FileCount++
				g.TotalSize += s.Size
				g.Files = append(g.Files, s)
			}
			groups := make([]specTaskGroup, 0, len(groupOrder))
			for _, slug := range groupOrder {
				groups = append(groups, *groupMap[slug])
			}
			msg.specGroups = groups

			msg.activity = ds.RecentActivity(50)
			msg.knStats = ds.KnowledgeStats()
			msg.epics = ds.Epics()
			msg.decisions = ds.AllDecisions(20)

			msg.knowledge = ds.RecentKnowledge(100)
			done <- msg
		}()

		select {
		case result := <-done:
			return result
		case <-time.After(4 * time.Second):
			// Timeout: return partial data (empty) so UI doesn't freeze.
			return dataLoadedMsg{}
		}
	}
}

// applyDataLoaded applies a dataLoadedMsg to the model (in-memory only, no I/O).
func (m *Model) applyDataLoaded(msg dataLoadedMsg) {
	m.activeSlug = msg.activeSlug
	m.allTasks = msg.allTasks
	m.specs = msg.specs
	m.specGroups = msg.specGroups
	if m.taskCursor >= len(m.allTasks) {
		m.taskCursor = max(0, len(m.allTasks)-1)
	}
	if m.specGroupCursor >= len(m.specGroups) {
		m.specGroupCursor = max(0, len(m.specGroups)-1)
	}
	m.activity = msg.activity
	// Rebuild activity table rows from timeline data.
	// Column widths scale proportionally to terminal width.
	if len(m.activity) > 0 {
		shown := min(20, len(m.activity))
		tblW := max(60, m.width-6)
		timeW := 6
		actionW := 12
		targetW := max(16, tblW*25/100)
		detailW := max(10, tblW-timeW-actionW-targetW-8) // 8 = cell padding
		rows := make([]table.Row, 0, shown)
		for i := range shown {
			a := m.activity[i]
			rows = append(rows, table.Row{
				a.Timestamp.Format("15:04"),
				formatAuditAction(a.Action),
				truncStr(a.Target, targetW),
				truncStr(a.Detail, detailW),
			})
		}
		m.activityTable.SetColumns([]table.Column{
			{Title: "Time", Width: timeW},
			{Title: "Action", Width: actionW},
			{Title: "Target", Width: targetW},
			{Title: "Detail", Width: detailW},
		})
		m.activityTable.SetWidth(tblW)
		m.activityTable.SetHeight(min(shown+1, 20))
		m.activityTable.SetRows(rows)
	}
	m.knStats = msg.knStats
	m.epics = msg.epics
	m.decisions = msg.decisions
	if msg.knowledge != nil {
		m.knowledge = msg.knowledge
		m.knList.SetItems(knowledgeEntriesToItems(m.knowledge))
	}
	// Compute promotion candidates from knowledge.
	m.promotions = m.promotions[:0]
	for _, k := range m.knowledge {
		if k.Source == "memory" {
			if (k.SubType == "general" && k.HitCount >= 5) || (k.SubType == "pattern" && k.HitCount >= 15) {
				m.promotions = append(m.promotions, k)
			}
		}
	}
	m.rebuildTasksViewport()
}

func (m *Model) rebuildTasksViewport() {
	if m.activeTab != tabTasks || m.width == 0 || m.taskLevel != 0 {
		return
	}

	var b strings.Builder
	maxW := m.width - 6

	// Active task details at top.
	task := m.findActiveTask()
	if task != nil {
		b.WriteString(m.renderTaskOverview(task))
		b.WriteString("\n  " + strings.Repeat("\u2500", min(maxW, 60)) + "\n\n")
	}

	// Active Tasks list with cursor.
	if len(m.allTasks) > 0 {
		b.WriteString("  " + sectionHeader.Render("Active Tasks") + "\n")
		for i, t := range m.allTasks {
			isCompleted := t.Status == "completed" || t.Status == "done" || t.Status == "implementation-complete"

			marker := "  "
			if i == m.taskCursor {
				marker = "> "
			}
			slug := fmt.Sprintf("%-24s", truncStr(t.Slug, 24))
			progBar := ""
			if t.Total > 0 {
				pct := float64(t.Completed) / float64(t.Total)
				barW := 10
				filled := int(pct * float64(barW))
				progBar = strings.Repeat("#", filled) + strings.Repeat("-", barW-filled)
				progBar += fmt.Sprintf(" %d%%", int(pct*100))
			}
			// Show status only for non-active (completed tasks need the label; active is implied).
			status := ""
			if isCompleted {
				status = styledStatus(t.Status)
			}
			blocker := " "
			if t.HasBlocker {
				blocker = blockerStyle.Render("!")
			}

			line := marker + slug + " " + progBar + " " + status + " " + blocker
			if i == m.taskCursor {
				b.WriteString(titleStyle.Render(marker+slug) + " " + progBar + " " + status + " " + blocker + "\n")
			} else if isCompleted {
				b.WriteString(dimStyle.Render(line) + "\n")
			} else {
				b.WriteString(line + "\n")
			}
		}
	}

	m.viewport.SetContent(b.String())
}

// rebuildTaskOverlay updates the Tasks tab overlay content for shimmer animation.
func (m *Model) rebuildTaskOverlay() {
	if !m.overlayActive || m.activeTab != tabTasks || m.taskLevel != 0 {
		return
	}
	if m.taskCursor >= len(m.allTasks) {
		return
	}
	task := &m.allTasks[m.taskCursor]
	// Preserve scroll position.
	yOff := m.overlayVP.YOffset()
	m.overlayVP.SetContent(m.renderTaskOverview(task))
	m.overlayVP.SetYOffset(yOff)
}

func (m *Model) findActiveTask() *TaskDetail {
	for i := range m.allTasks {
		if m.allTasks[i].Slug == m.activeSlug {
			return &m.allTasks[i]
		}
	}
	if len(m.allTasks) > 0 {
		return &m.allTasks[0]
	}
	return nil
}

func (m *Model) switchTab(tab int) {
	m.activeTab = tab
	m.searchBusy = false
	if tab == tabTasks {
		m.taskLevel = 0
		m.rebuildTasksViewport()
	}
}

// tryDirectReview attempts to enter review mode for the active task from Overview.
func (m *Model) tryDirectReview() (tea.Model, tea.Cmd) {
	task := m.findActiveTask()
	if task == nil {
		return m, nil
	}
	status := spec.ReviewStatusFor(m.ds.ProjectPath(), task.Slug)
	if status != spec.ReviewPending {
		return m, nil
	}
	// Find the task in specGroups and open review on the first file.
	for gi, g := range m.specGroups {
		if g.Slug == task.Slug && len(g.Files) > 0 {
			m.specGroupCursor = gi
			m.specFileCursor = 0
			f := g.Files[0]
			content := m.ds.SpecContent(f.TaskSlug, f.File)
			m.openOverlay(f.File, m.renderMarkdown(content), "Specs", g.Slug, f.File)
			m.enterReviewMode()
			return m, nil
		}
	}
	return m, nil
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
		shimmerCmd(),
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
		m.mdRenderer, _ = glamour.NewTermRenderer(
			glamour.WithAutoStyle(),
			glamour.WithWordWrap(max(40, m.width-6)),
		)
		m.viewport = viewport.New(
			viewport.WithWidth(m.width-4),
			viewport.WithHeight(m.contentHeight()),
		)
		m.viewport.SoftWrap = true
		m.progress = progress.New(
			progress.WithColors(aqua, lipgloss.Color("#333")),
			progress.WithoutPercentage(),
			progress.WithWidth(min(20, m.width/4)),
			progress.WithFillCharacters('#', '-'),
		)
		m.knList.SetSize(m.width-4, m.contentHeight()-4)
		// Resize activity table to fit terminal width (proportional columns).
		{
			tblW := max(60, m.width-6)
			targetW := max(16, tblW*25/100)
			detailW := max(10, tblW-6-12-targetW-8)
			m.activityTable.SetColumns([]table.Column{
				{Title: "Time", Width: 6},
				{Title: "Action", Width: 12},
				{Title: "Target", Width: targetW},
				{Title: "Detail", Width: detailW},
			})
			m.activityTable.SetWidth(tblW)
			m.activityTable.SetHeight(min(20, m.contentHeight()-8))
		}
		return m, m.loadDataCmd()

	case clipboardMsg:
		// Clipboard copy completed — flash resets on next key press.
		return m, nil

	case dataLoadedMsg:
		m.applyDataLoaded(msg)
		return m, nil

	case tickMsg:
		return m, tea.Batch(
			m.loadDataCmd(),
			tea.Tick(5*time.Second, func(t time.Time) tea.Msg {
				return tickMsg(t)
			}),
		)

	case searchResultMsg:
		// Legacy: kept for potential semantic search integration.
		m.knowledge = []KnowledgeEntry(msg)
		m.searchBusy = false
		m.updateKnowledgeListItems()
		return m, nil

	case shimmerTickMsg:
		m.shimmerFrame++
		// Rebuild viewports that contain shimmer content.
		m.rebuildTasksViewport()
		m.rebuildTaskOverlay()
		cmds = append(cmds, shimmerCmd())
		return m, tea.Batch(cmds...)

	case spinner.TickMsg:
		if m.searchBusy {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			cmds = append(cmds, cmd)
		}

	case progress.FrameMsg:
		var cmd tea.Cmd
		m.progress, cmd = m.progress.Update(msg)
		cmds = append(cmds, cmd)

	case tea.KeyPressMsg:
		// Overlay takes priority — all input goes to the floating window.
		if m.overlayActive {
			return m.updateOverlay(msg)
		}
		// List component handles its own filtering when active.
		if m.activeTab == tabKnowledge && m.knList.FilterState() == list.Filtering {
			var cmd tea.Cmd
			m.knList, cmd = m.knList.Update(msg)
			return m, cmd
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
			m.switchTab((m.activeTab + 1) % tabCount)
			return m, nil
		case key.Matches(msg, keys.BackTab):
			m.switchTab((m.activeTab - 1 + tabCount) % tabCount)
			return m, nil
		case key.Matches(msg, keys.Search):
			// Knowledge tab: delegate to list's built-in filter (type "/" to search).
			if m.activeTab == tabKnowledge && !m.overlayActive {
				var cmd tea.Cmd
				m.knList, cmd = m.knList.Update(msg)
				return m, cmd
			}
		case key.Matches(msg, keys.Review):
			// Direct review shortcut from Tasks tab.
			if m.activeTab == tabTasks && m.taskLevel == 0 && !m.overlayActive {
				return m.tryDirectReview()
			}
		}

		// Delegate to active tab.
		switch m.activeTab {
		case tabTasks:
			if m.taskLevel == 0 {
				return m.updateTasksList(msg)
			}
			return m.updateSpecs(msg)
		case tabKnowledge:
			return m.updateKnowledge(msg)
		case tabActivity:
			m.viewport, _ = m.viewport.Update(msg)
		}
	}

	return m, tea.Batch(cmds...)
}

func (m *Model) updateTasksList(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, keys.Down):
		if m.taskCursor < len(m.allTasks)-1 {
			m.taskCursor++
			m.rebuildTasksViewport()
		}
	case key.Matches(msg, keys.Up):
		if m.taskCursor > 0 {
			m.taskCursor--
			m.rebuildTasksViewport()
		}
	case key.Matches(msg, keys.Enter):
		if m.taskCursor < len(m.allTasks) {
			task := m.allTasks[m.taskCursor]
			// Try to enter spec file view for this task.
			for gi, g := range m.specGroups {
				if g.Slug == task.Slug {
					m.specGroupCursor = gi
					m.specFileCursor = 0
					m.specLevel = 1
					m.taskLevel = 1
					return m, nil
				}
			}
			// No specs — show task detail in overlay.
			m.openOverlay(task.Slug, m.renderTaskOverview(&task), "Tasks", task.Slug)
		}
	}
	return m, nil
}

func (m *Model) updateSpecs(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch m.specLevel {
	case 0: // task group list
		switch {
		case key.Matches(msg, keys.Down):
			if m.specGroupCursor < len(m.specGroups)-1 {
				m.specGroupCursor++
			}
		case key.Matches(msg, keys.Up):
			if m.specGroupCursor > 0 {
				m.specGroupCursor--
			}
		case key.Matches(msg, keys.Enter):
			if m.specGroupCursor < len(m.specGroups) {
				m.specFileCursor = 0
				m.specLevel = 1
			}
		case key.Matches(msg, keys.Back):
			m.taskLevel = 0
			m.rebuildTasksViewport()
		}
	case 1: // file list
		switch {
		case key.Matches(msg, keys.Down):
			if m.specGroupCursor < len(m.specGroups) {
				g := m.specGroups[m.specGroupCursor]
				if m.specFileCursor < len(g.Files)-1 {
					m.specFileCursor++
				}
			}
		case key.Matches(msg, keys.Up):
			if m.specFileCursor > 0 {
				m.specFileCursor--
			}
		case key.Matches(msg, keys.Enter):
			if m.specGroupCursor < len(m.specGroups) {
				g := m.specGroups[m.specGroupCursor]
				if m.specFileCursor < len(g.Files) {
					f := g.Files[m.specFileCursor]
					content := m.ds.SpecContent(f.TaskSlug, f.File)
					m.openOverlay(
						f.File,
						m.renderMarkdown(content),
						"Specs", g.Slug, f.File,
					)
				}
			}
		case key.Matches(msg, keys.Back):
			m.specLevel = 0
			m.taskLevel = 0
			m.rebuildTasksViewport()
		}
	}
	return m, nil
}

func (m *Model) updateKnowledge(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	// Space: toggle enabled/disabled.
	if key.Matches(msg, knowledgeToggleKey) {
		idx := m.knList.Index()
		if idx < len(m.knowledge) {
			k := &m.knowledge[idx]
			if k.ID > 0 {
				newState := !k.Enabled
				if err := m.ds.ToggleEnabled(k.ID, newState); err == nil {
					m.syncKnowledgeItemEnabled(idx, newState)
				}
			}
		}
		return m, nil
	}

	// Enter: open detail overlay.
	if key.Matches(msg, keys.Enter) {
		if item := m.knList.SelectedItem(); item != nil {
			ki := item.(knowledgeItem)
			title := extractKnowledgeTitle(ki.entry)
			// Strip the leading "# title" from body to avoid triple repetition
			// (breadcrumb + overlay title + body heading).
			rawMD := renderKnowledgeDetailNoTitle(ki.entry)
			m.openOverlay(
				title,
				m.renderMarkdown(rawMD),
				"Knowledge", ki.entry.Source,
			)
			// Store raw markdown with title for clipboard copy.
			m.overlayRawMD = "# " + title + "\n\n" + rawMD
		}
		return m, nil
	}

	// Delegate all other keys (up/down/filter/pgup/pgdn) to the list.
	var cmd tea.Cmd
	m.knList, cmd = m.knList.Update(msg)
	return m, cmd
}


// ---------------------------------------------------------------------------
// Overlay (floating window)
// ---------------------------------------------------------------------------

func (m *Model) openOverlay(title, content string, crumbs ...string) {
	m.overlayActive = true
	m.overlayTitle = title
	m.overlayRawMD = ""
	m.overlayCopied = false
	m.breadcrumbs = crumbs

	// Size the overlay viewport — use 85% of terminal width.
	w := min(m.width-4, m.width*85/100)
	if w < 60 {
		w = min(m.width-4, 60)
	}
	h := m.height - 8
	if h < 5 {
		h = 5
	}

	m.overlayVP = viewport.New(
		viewport.WithWidth(w - 4), // padding inside border
		viewport.WithHeight(h - 3),
	)
	m.overlayVP.SoftWrap = true
	m.overlayVP.SetContent(content)
}

func (m *Model) updateOverlay(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	// Review comment editing mode — text input takes all keys.
	if m.reviewEditing {
		return m.updateReviewInput(msg)
	}

	// Review mode navigation.
	if m.reviewMode {
		return m.updateReviewMode(msg)
	}

	// Reset "Copied!" flash on any key press.
	m.overlayCopied = false

	switch {
	case key.Matches(msg, keys.Back), key.Matches(msg, keys.Quit):
		m.overlayActive = false
		return m, nil
	case msg.String() == "r" && m.activeTab == tabTasks && m.taskLevel > 0:
		// Enter review mode — only when task has pending review.
		if m.specGroupCursor < len(m.specGroups) {
			slug := m.specGroups[m.specGroupCursor].Slug
			status := spec.ReviewStatusFor(m.ds.ProjectPath(), slug)
			if status != spec.ReviewPending {
				return m, nil // not pending — ignore
			}
		}
		m.enterReviewMode()
		return m, nil
	case msg.String() == "c" && m.overlayRawMD != "":
		// Copy raw markdown to clipboard.
		cmd := copyToClipboard(m.overlayRawMD)
		m.overlayCopied = true
		return m, cmd
	case msg.String() == "d" && m.activeTab == tabTasks && m.taskLevel > 0 && !m.reviewMode:
		// Show diff against previous version.
		m.showSpecDiff()
		return m, nil
	default:
		var cmd tea.Cmd
		m.overlayVP, cmd = m.overlayVP.Update(msg)
		return m, cmd
	}
}

// showSpecDiff shows a diff between the current spec file and its last saved version.
func (m *Model) showSpecDiff() {
	if m.specGroupCursor >= len(m.specGroups) {
		return
	}
	g := m.specGroups[m.specGroupCursor]
	if m.specFileCursor >= len(g.Files) {
		return
	}
	f := g.Files[m.specFileCursor]
	sd := &spec.SpecDir{ProjectPath: m.ds.ProjectPath(), TaskSlug: f.TaskSlug}

	// Get history entries.
	history, err := sd.History(spec.SpecFile(f.File))
	if err != nil || len(history) == 0 {
		m.overlayVP.SetContent(dimStyle.Render("  no previous versions"))
		m.overlayTitle = "Diff: " + f.File
		return
	}

	// Read current and previous version.
	current := m.ds.SpecContent(f.TaskSlug, f.File)
	prevData, err := os.ReadFile(history[0].Path)
	if err != nil {
		m.overlayVP.SetContent(dimStyle.Render("  cannot read previous version"))
		m.overlayTitle = "Diff: " + f.File
		return
	}
	previous := string(prevData)

	// Unified diff using go-diff.
	diff := renderUnifiedDiff(previous, current)
	ts, _ := time.Parse("20060102-150405", history[0].Timestamp)
	age := time.Since(ts)
	m.overlayTitle = fmt.Sprintf("Diff: %s (vs %s ago)", f.File, formatDuration(age))
	m.overlayVP.SetContent(diff)
}

// renderUnifiedDiff produces a colored unified diff between two texts.
// Uses go-diff for semantic line diff with context lines.
func renderUnifiedDiff(old, new string) string {
	diffs := dmp.DiffMain(old, new, true)
	diffs = dmp.DiffCleanupSemantic(diffs)

	addStyle := lipgloss.NewStyle().Foreground(green)
	delStyle := lipgloss.NewStyle().Foreground(red)
	headerStyle := lipgloss.NewStyle().Foreground(aqua)

	var b strings.Builder
	addedCount, removedCount := 0, 0

	for _, d := range diffs {
		lines := strings.Split(d.Text, "\n")
		// Last empty element from trailing newline — keep it attached.
		for i, line := range lines {
			// Skip the empty string that results from a trailing newline.
			if i == len(lines)-1 && line == "" {
				continue
			}
			switch d.Type {
			case diffmatchpatch.DiffDelete:
				b.WriteString(delStyle.Render("  - "+line) + "\n")
				removedCount++
			case diffmatchpatch.DiffInsert:
				b.WriteString(addStyle.Render("  + "+line) + "\n")
				addedCount++
			case diffmatchpatch.DiffEqual:
				b.WriteString("    " + line + "\n")
			}
		}
	}

	if removedCount == 0 && addedCount == 0 {
		b.WriteString(dimStyle.Render("  no changes"))
	} else {
		b.WriteString(fmt.Sprintf("\n  %s",
			headerStyle.Render(fmt.Sprintf("%d removed, %d added", removedCount, addedCount))))
	}

	return b.String()
}

// dmp is the shared DiffMatchPatch instance for diff computation.
var dmp = diffmatchpatch.New()

// enterReviewMode initializes review mode for the currently viewed spec file.
func (m *Model) enterReviewMode() {
	if m.specGroupCursor >= len(m.specGroups) {
		return
	}
	g := m.specGroups[m.specGroupCursor]
	if m.specFileCursor >= len(g.Files) {
		return
	}
	f := g.Files[m.specFileCursor]
	content := m.ds.SpecContent(f.TaskSlug, f.File)

	m.reviewMode = true
	m.reviewFile = f.File
	m.reviewTaskSlug = f.TaskSlug
	m.reviewLines = strings.Split(content, "\n")
	m.reviewCursor = 0
	m.reviewComments = make(map[int]string)
	m.reviewEditing = false
	m.reviewConfirmPending = false

	// Load all review rounds.
	sd := &spec.SpecDir{ProjectPath: m.ds.ProjectPath(), TaskSlug: f.TaskSlug}
	rounds, _ := sd.AllReviews()
	m.reviewRounds = rounds
	m.reviewRoundIdx = len(rounds) // new round (beyond existing)

	ta := textarea.New()
	ta.Placeholder = "comment..."
	ta.CharLimit = 500
	ta.SetHeight(3)
	ta.ShowLineNumbers = false
	m.reviewInput = ta

	m.rebuildReviewOverlay()
}

// updateReviewMode handles keys in review navigation mode.
func (m *Model) updateReviewMode(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	isLatestRound := m.reviewRoundIdx >= len(m.reviewRounds)

	switch {
	case key.Matches(msg, keys.Back), key.Matches(msg, keys.Quit):
		m.reviewMode = false
		// Restore normal overlay content.
		if m.specGroupCursor < len(m.specGroups) {
			g := m.specGroups[m.specGroupCursor]
			if m.specFileCursor < len(g.Files) {
				f := g.Files[m.specFileCursor]
				content := m.ds.SpecContent(f.TaskSlug, f.File)
				m.overlayVP.SetContent(m.renderMarkdown(content))
				m.overlayTitle = f.File
			}
		}
		return m, nil

	case key.Matches(msg, keys.Down):
		if m.reviewCursor < len(m.reviewLines)-1 {
			m.reviewCursor++
			m.rebuildReviewOverlay()
		}
		return m, nil

	case key.Matches(msg, keys.Up):
		if m.reviewCursor > 0 {
			m.reviewCursor--
			m.rebuildReviewOverlay()
		}
		return m, nil

	case msg.String() == "left":
		// Navigate to previous review round.
		if m.reviewRoundIdx > 0 {
			m.reviewRoundIdx--
			m.reviewComments = m.commentsForRound(m.reviewRoundIdx)
			m.rebuildReviewOverlay()
		}
		return m, nil

	case msg.String() == "right":
		// Navigate to next review round / new round.
		if m.reviewRoundIdx < len(m.reviewRounds) {
			m.reviewRoundIdx++
			if m.reviewRoundIdx >= len(m.reviewRounds) {
				// New round: clear comments for fresh editing.
				m.reviewComments = make(map[int]string)
			} else {
				m.reviewComments = m.commentsForRound(m.reviewRoundIdx)
			}
			m.rebuildReviewOverlay()
		}
		return m, nil

	case msg.String() == "c" && isLatestRound:
		// Start commenting on current line (only in new/latest round).
		m.reviewEditing = true
		m.reviewInputLine = m.reviewCursor
		m.reviewInput.SetValue("")
		if existing, ok := m.reviewComments[m.reviewCursor]; ok {
			m.reviewInput.SetValue(existing)
		}
		m.reviewInput.Focus()
		return m, nil

	case msg.String() == "a" && isLatestRound && !m.reviewConfirmPending:
		// Approve — require confirmation.
		m.reviewConfirmPending = true
		m.reviewConfirmStatus = spec.ReviewApproved
		m.rebuildReviewOverlay()
		return m, nil

	case msg.String() == "x" && isLatestRound && !m.reviewConfirmPending:
		// Request Changes — require confirmation.
		m.reviewConfirmPending = true
		m.reviewConfirmStatus = spec.ReviewChangesRequested
		m.rebuildReviewOverlay()
		return m, nil

	case msg.String() == "y" && m.reviewConfirmPending:
		// Confirm submission.
		m.reviewConfirmPending = false
		m.submitReview(m.reviewConfirmStatus)
		return m, nil

	case msg.String() == "n" && m.reviewConfirmPending:
		// Cancel submission.
		m.reviewConfirmPending = false
		m.rebuildReviewOverlay()
		return m, nil

	case msg.String() == "d" && isLatestRound:
		// Delete comment on current line (only in new round).
		delete(m.reviewComments, m.reviewCursor)
		m.rebuildReviewOverlay()
		return m, nil

	default:
		var cmd tea.Cmd
		m.overlayVP, cmd = m.overlayVP.Update(msg)
		return m, cmd
	}
}

// commentsForRound extracts comments from a historical review round as a line→body map.
// Only includes comments for the currently viewed file.
func (m *Model) commentsForRound(idx int) map[int]string {
	comments := make(map[int]string)
	if idx >= len(m.reviewRounds) {
		return comments
	}
	r := m.reviewRounds[idx]
	for _, c := range r.Comments {
		if c.File == m.reviewFile {
			comments[c.Line-1] = c.Body // convert 1-based to 0-based
		}
	}
	return comments
}

// carriedComments returns unresolved comments from all previous rounds
// (before the current round) as a line→body map. Used to highlight
// comments that haven't been addressed yet.
func (m *Model) carriedComments() map[int]string {
	carried := make(map[int]string)
	// Only show carried comments in the latest (new) round.
	if m.reviewRoundIdx < len(m.reviewRounds) {
		return carried
	}
	for _, r := range m.reviewRounds {
		for _, c := range r.Comments {
			if c.File == m.reviewFile && !c.Resolved {
				carried[c.Line-1] = c.Body
			}
		}
	}
	return carried
}

// updateReviewInput handles keys while typing a comment.
// ctrl+s saves, esc cancels. Enter inserts newlines in the textarea.
func (m *Model) updateReviewInput(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+s":
		// Save comment.
		body := strings.TrimSpace(m.reviewInput.Value())
		if body != "" {
			m.reviewComments[m.reviewInputLine] = body
		}
		m.reviewEditing = false
		m.reviewInput.Blur()
		m.rebuildReviewOverlay()
		return m, nil
	case "esc":
		// Cancel editing.
		m.reviewEditing = false
		m.reviewInput.Blur()
		m.rebuildReviewOverlay()
		return m, nil
	default:
		var cmd tea.Cmd
		m.reviewInput, cmd = m.reviewInput.Update(msg)
		return m, cmd
	}
}

// submitReview saves the review and updates the active task's review status.
func (m *Model) submitReview(status spec.ReviewStatus) {
	sd := &spec.SpecDir{
		ProjectPath: m.ds.ProjectPath(),
		TaskSlug:    m.reviewTaskSlug,
	}

	// Build review comments.
	var comments []spec.ReviewComment
	for line, body := range m.reviewComments {
		comments = append(comments, spec.ReviewComment{
			File: m.reviewFile,
			Line: line + 1, // 1-based
			Body: body,
		})
	}

	review := &spec.Review{
		Status:   status,
		Comments: comments,
	}
	if len(m.reviewComments) > 0 {
		review.Summary = fmt.Sprintf("%d comments on %s", len(comments), m.reviewFile)
	}

	_ = sd.SaveReview(review) // best-effort
	_ = spec.SetReviewStatus(m.ds.ProjectPath(), m.reviewTaskSlug, status)
	spec.AppendAudit(m.ds.ProjectPath(), spec.AuditEntry{
		Action: "review.submit",
		Target: m.reviewTaskSlug + "/" + m.reviewFile,
		Detail: fmt.Sprintf("status=%s comments=%d", status, len(comments)),
		User:   "tui",
	})

	// Exit review mode.
	m.reviewMode = false
	m.overlayTitle = fmt.Sprintf("Review submitted: %s", status)
	m.overlayVP.SetContent(fmt.Sprintf(
		"\n  Review saved for %s/%s\n  Status: %s\n  Comments: %d\n\n  %s",
		m.reviewTaskSlug, m.reviewFile, status, len(comments),
		dimStyle.Render("press esc to close"),
	))
}

// Review mode styles.
var (
	reviewCursorStyle = lipgloss.NewStyle().
				Background(lipgloss.Color("#2e3430")).
				Foreground(fgWarm)

	reviewLineNumStyle = lipgloss.NewStyle().
				Foreground(gray)

	reviewLineNumCursorStyle = lipgloss.NewStyle().
					Background(lipgloss.Color("#2e3430")).
					Foreground(aqua).
					Bold(true)

	reviewCommentMarker = lipgloss.NewStyle().
				Foreground(gold).
				Bold(true)

	reviewCommentStyle = lipgloss.NewStyle().
				Foreground(gold)

	reviewInputBorder = lipgloss.NewStyle().
				Border(lipgloss.RoundedBorder()).
				BorderForeground(gold).
				Padding(0, 1).
				MarginTop(1)
)

// rebuildReviewOverlay renders the line-numbered review view into the overlay.
func (m *Model) rebuildReviewOverlay() {
	var b strings.Builder
	w := m.overlayVP.Width() - 2
	lineW := w - 8 // gutter(4 digits + marker + space) = 7, plus margin

	isLatestRound := m.reviewRoundIdx >= len(m.reviewRounds)

	// Round navigation bar.
	totalRounds := len(m.reviewRounds) + 1 // +1 for new round
	roundLabel := fmt.Sprintf("Round %d/%d", m.reviewRoundIdx+1, totalRounds)
	if isLatestRound {
		roundLabel += " (new)"
	} else {
		r := m.reviewRounds[m.reviewRoundIdx]
		roundLabel += fmt.Sprintf(" [%s]", r.Status)
	}
	navHint := ""
	if m.reviewRoundIdx > 0 {
		navHint += "<- "
	}
	navHint += roundLabel
	if m.reviewRoundIdx < len(m.reviewRounds) {
		navHint += " ->"
	}
	b.WriteString("  " + reviewRoundStyle.Render(navHint) + "\n")

	// Status bar.
	commentCount := len(m.reviewComments)
	statusLine := dimStyle.Render(fmt.Sprintf("  %s  ", m.reviewFile))
	if commentCount > 0 {
		statusLine += reviewCommentMarker.Render(fmt.Sprintf("  %d comment(s)", commentCount))
	}
	if !isLatestRound {
		statusLine += dimStyle.Render("  (read-only)")
	}
	b.WriteString(statusLine + "\n\n")

	// Collect carried-over (unresolved) comments from previous rounds for highlight.
	carried := m.carriedComments()

	for i, line := range m.reviewLines {
		lineNum := fmt.Sprintf("%4d", i+1)
		isCursor := i == m.reviewCursor
		_, hasComment := m.reviewComments[i]

		// Gutter: line number + comment marker.
		marker := " "
		if hasComment {
			marker = reviewCommentMarker.Render("*")
		}

		// Truncate line content.
		text := line
		runes := []rune(text)
		if len(runes) > lineW {
			text = string(runes[:lineW])
		}

		if isCursor {
			// Active line: full background highlight.
			// Pad text to fill width for continuous background.
			padded := text
			if len([]rune(padded)) < lineW {
				padded += strings.Repeat(" ", lineW-len([]rune(padded)))
			}
			b.WriteString(reviewLineNumCursorStyle.Render(lineNum) + marker + " " + reviewCursorStyle.Render(padded) + "\n")
		} else {
			b.WriteString(reviewLineNumStyle.Render(lineNum) + marker + " " + text + "\n")
		}

		// Show inline comment below the line.
		if hasComment {
			comment := m.reviewComments[i]
			b.WriteString("      " + reviewCommentStyle.Render("  "+comment) + "\n")
		}

		// Show carried-over unresolved comments from previous rounds (dimmer).
		if carriedComment, ok := carried[i]; ok && !hasComment {
			b.WriteString("      " + reviewCarriedStyle.Render("  [prev] "+carriedComment) + "\n")
		}
	}

	// Confirmation prompt for review submission.
	if m.reviewConfirmPending {
		action := "Approve"
		if m.reviewConfirmStatus == spec.ReviewChangesRequested {
			action = "Request Changes"
		}
		prompt := reviewCommentMarker.Render(fmt.Sprintf("  %s? (y/n)", action))
		b.WriteString("\n" + prompt + "\n")
	}

	// Comment input area — fixed at bottom, clearly separated.
	if m.reviewEditing {
		inputLabel := fmt.Sprintf(" Line %d ", m.reviewInputLine+1)
		inputContent := reviewInputBorder.Width(min(w-4, 80)).Render(
			reviewCommentMarker.Render(inputLabel) + "\n" + m.reviewInput.View(),
		)
		b.WriteString("\n" + inputContent + "\n")
	}

	m.overlayTitle = fmt.Sprintf("Review: %s", m.reviewFile)
	m.overlayVP.SetContent(b.String())

	// Scroll position: center on cursor, but force to bottom when confirming.
	if m.reviewConfirmPending {
		m.overlayVP.GotoBottom()
	} else {
		targetOffset := max(0, m.reviewCursor-m.overlayVP.Height()/2)
		m.overlayVP.SetYOffset(targetOffset)
	}
}

func (m Model) renderOverlayView(bg string) string {
	w := min(m.width-2, m.width*87/100)
	if w < 64 {
		w = min(m.width-2, 64)
	}
	h := m.height - 4

	// Title bar only — no breadcrumb.
	titleBar := "  " + overlayTitleStyle.Render(m.overlayTitle) + "\n"

	// Viewport content.
	content := titleBar + m.overlayVP.View()

	// Footer: hints + scroll position.
	hint := "esc: close  j/k: scroll"
	if m.overlayRawMD != "" {
		hint += "  c: copy"
	}
	if m.activeTab == tabTasks && m.taskLevel > 0 && !m.reviewMode {
		isPending := false
		if m.specGroupCursor < len(m.specGroups) {
			slug := m.specGroups[m.specGroupCursor].Slug
			isPending = spec.ReviewStatusFor(m.ds.ProjectPath(), slug) == spec.ReviewPending
		}
		if isPending {
			hint = "esc: close  j/k: scroll  r: review  d: diff"
		} else {
			hint = "esc: close  j/k: scroll  d: diff"
		}
	} else if m.reviewMode && !m.reviewEditing {
		isLatest := m.reviewRoundIdx >= len(m.reviewRounds)
		if isLatest {
			hint = "esc: back  j/k: move  </>: rounds  c: comment  d: del  a: approve  x: changes"
		} else {
			hint = "esc: back  j/k: scroll  </>: rounds  (read-only)"
		}
	} else if m.reviewEditing {
		hint = "ctrl+s: save  esc: cancel"
	}
	pct := m.overlayVP.ScrollPercent()
	copiedFlash := ""
	if m.overlayCopied {
		copiedFlash = "  " + scoreStyle.Render("Copied!")
	}
	footer := dimStyle.Render(fmt.Sprintf("  %s  %d%%", hint, int(pct*100))) + copiedFlash
	content += "\n" + footer

	// Panel with border.
	panel := overlayStyle.
		Width(w).
		Height(h).
		Render(content)

	// Center the panel on screen.
	return lipgloss.Place(m.width, m.height,
		lipgloss.Center, lipgloss.Center,
		panel,
		lipgloss.WithWhitespaceChars("·"),
		lipgloss.WithWhitespaceStyle(lipgloss.NewStyle().Foreground(lipgloss.Color("#1a1a1a"))),
	)
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

// termResponseRe matches terminal responses that leak as visible text.
// DECRPM: [?2026;2$y  CPR: [8;1R  DA: [?65;1c
var termResponseRe = regexp.MustCompile(`\[\??\d+[;\d]*(?:\$y|[Rc])`)

// stripDECRPM removes leaked terminal capability responses from rendered output.
func stripDECRPM(s string) string {
	return termResponseRe.ReplaceAllString(s, "")
}

func (m Model) View() tea.View {
	if m.width == 0 {
		return tea.NewView("")
	}

	var content string
	if m.showHelp {
		content = "\n" + m.helpModel.FullHelpView(keys.FullHelp())
	} else {
		switch m.activeTab {
		case tabTasks:
			if m.taskLevel == 0 {
				content = m.tasksView()
			} else {
				content = m.specsView()
			}
		case tabKnowledge:
			content = m.knowledgeListView()
		case tabActivity:
			content = m.activityView()
		}
	}

	bg := lipgloss.JoinVertical(lipgloss.Left,
		m.tabBarView(),
		content,
		m.helpBar(),
	)

	// Render overlay on top if active.
	var view string
	if m.overlayActive {
		view = m.renderOverlayView(bg)
	} else {
		view = bg
	}

	v := tea.NewView(stripDECRPM(view))
	v.AltScreen = true
	return v
}

func (m Model) tabBarView() string {
	// Title: "alfred dashboard vX.Y.Z"
	title := titleBarStyle.Render("alfred dashboard")
	if m.version != "" {
		title += " " + versionStyle.Render("v"+m.version)
	}

	var tabs []string
	for i, name := range tabNames {
		label := name + m.tabBadge(i)
		if i == m.activeTab {
			tabs = append(tabs, activeTabStyle.Render(label))
		} else {
			tabs = append(tabs, inactiveTabStyle.Render(label))
		}
	}
	tabRow := lipgloss.JoinHorizontal(lipgloss.Top, tabs...)
	if m.searchBusy {
		tabRow += " " + m.spinner.View()
	}

	return tabBarStyle.Width(m.width).Render(
		title + "\n\n" + tabRow,
	)
}

// tabBadge returns a count/alert badge for a given tab.
func (m Model) tabBadge(tab int) string {
	switch tab {
	case tabTasks:
		if len(m.allTasks) == 0 {
			return ""
		}
		hasBlocker := false
		for _, t := range m.allTasks {
			if t.HasBlocker {
				hasBlocker = true
				break
			}
		}
		if hasBlocker {
			return fmt.Sprintf("(%d!)", len(m.allTasks))
		}
		return fmt.Sprintf("(%d)", len(m.allTasks))
	case tabKnowledge:
		total := m.knStats.Total
		if total == 0 {
			return ""
		}
		return fmt.Sprintf("(%d)", total)
	case tabActivity:
		if len(m.activity) == 0 {
			return ""
		}
		return fmt.Sprintf("(%d)", len(m.activity))
	default:
		return ""
	}
}

func (m Model) helpBar() string {
	return "\n" + m.helpModel.ShortHelpView(keys.ShortHelp())
}

// ---------------------------------------------------------------------------
// Tab views
// ---------------------------------------------------------------------------

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

	// Focus — warm white for readability.
	if td.Focus != "" {
		focusStyle := lipgloss.NewStyle().Foreground(fgWarm)
		b.WriteString("  " + focusStyle.Render(td.Focus) + "\n")
	}
	b.WriteString("\n")

	// Blockers (prominent if present).
	if td.HasBlocker {
		b.WriteString("  " + blockerStyle.Render("! BLOCKER") + "  " + td.BlockerText + "\n\n")
	}

	// Next Steps. First unchecked item = currently active → shimmer.
	if len(td.NextSteps) > 0 {
		b.WriteString("  " + sectionHeader.Render("Next Steps") + "\n")
		foundActive := false
		for _, s := range td.NextSteps {
			check := checkUndone
			if s.Done {
				check = checkDone
			}
			text := truncStr(s.Text, maxW-6)
			if s.Done {
				b.WriteString("  " + check + " " + dimStyle.Render(text) + "\n")
			} else if !foundActive {
				foundActive = true
				b.WriteString("  " + check + " " + renderShimmerBold(text, m.shimmerFrame) + "\n")
			} else {
				uncheckedStyle := lipgloss.NewStyle().Foreground(fgWarm)
				b.WriteString("  " + check + " " + uncheckedStyle.Render(text) + "\n")
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
	if len(m.allTasks) == 0 {
		return "\n" + dimStyle.Render("  no tasks — use dossier init to start")
	}
	var hint string
	task := m.findActiveTask()
	if task != nil {
		status := spec.ReviewStatusFor(m.ds.ProjectPath(), task.Slug)
		if status == spec.ReviewPending {
			hint = "\n" + reviewCommentMarker.Render("  r: open review for "+task.Slug)
		}
	}
	return "\n" + m.viewport.View() + hint
}

func (m Model) specsView() string {
	if len(m.specGroups) == 0 {
		return "\n" + dimStyle.Render("  no specs")
	}

	switch m.specLevel {
	case 1: // file list for selected task
		return m.specFilesView()
	default: // task group list
		return m.specGroupsView()
	}
}

func (m Model) specGroupsView() string {
	var b strings.Builder
	b.WriteString("\n")

	visibleH := m.contentHeight() - 1
	startIdx, endIdx := visibleRange(m.specGroupCursor, len(m.specGroups), visibleH)

	for i := startIdx; i < endIdx; i++ {
		g := m.specGroups[i]
		prefix := "  "
		if i == m.specGroupCursor {
			prefix = "> "
		}

		slug := fmt.Sprintf("%-28s", truncStr(g.Slug, 28))
		info := fmt.Sprintf("%d files  %s", g.FileCount, formatSize(g.TotalSize))

		if i == m.specGroupCursor {
			b.WriteString(titleStyle.Render(prefix+slug) + "  " + dimStyle.Render(info) + "\n")
		} else {
			b.WriteString(prefix + slug + "  " + dimStyle.Render(info) + "\n")
		}
	}

	if len(m.specGroups) > visibleH {
		b.WriteString(dimStyle.Render(fmt.Sprintf("\n  %d/%d", m.specGroupCursor+1, len(m.specGroups))))
	}

	return b.String()
}

func (m Model) specFilesView() string {
	if m.specGroupCursor >= len(m.specGroups) {
		return "\n" + dimStyle.Render("  no files")
	}
	g := m.specGroups[m.specGroupCursor]

	var b strings.Builder
	maxW := m.width - 6

	// Find task status for this spec group.
	taskStatus := ""
	reviewStatus := ""
	for _, t := range m.allTasks {
		if t.Slug == g.Slug {
			taskStatus = t.Status
			break
		}
	}
	rs := spec.ReviewStatusFor(m.ds.ProjectPath(), g.Slug)
	if rs == spec.ReviewPending {
		reviewStatus = reviewCommentMarker.Render(" [review pending]")
	}

	b.WriteString("\n  " + titleStyle.Render(g.Slug))
	if taskStatus != "" {
		b.WriteString("  " + styledStatus(taskStatus))
	}
	b.WriteString(reviewStatus)
	b.WriteString("  " + dimStyle.Render(fmt.Sprintf("%d files  %s", g.FileCount, formatSize(g.TotalSize))))
	b.WriteString("\n")

	// Render rich summary from spec files.
	for i, f := range g.Files {
		content := m.ds.SpecContent(f.TaskSlug, f.File)

		prefix := "  "
		if i == m.specFileCursor {
			prefix = "> "
		}

		// Section header with file name.
		header := specFileLabel(f.File)
		if i == m.specFileCursor {
			b.WriteString("\n" + titleStyle.Render(prefix+header) + "  " + dimStyle.Render(formatSize(f.Size)) + "\n")
		} else {
			b.WriteString("\n" + prefix + sectionHeader.Render(header) + "  " + dimStyle.Render(formatSize(f.Size)) + "\n")
		}

		// Render a summary based on file type.
		switch f.File {
		case "decisions.md":
			renderDecisionsSummary(&b, content, maxW)
		case "session.md":
			renderSessionSummary(&b, content, maxW)
		case "requirements.md":
			renderRequirementsSummary(&b, content, maxW)
		case "design.md":
			renderDesignSummary(&b, content, maxW)
		default:
			if line := firstContentLine(content); line != "" {
				b.WriteString("    " + dimStyle.Render(truncStr(line, maxW-4)) + "\n")
			}
		}
	}

	b.WriteString("\n" + dimStyle.Render("  enter: view full file  esc: back"))

	return b.String()
}

func specFileLabel(file string) string {
	switch file {
	case "requirements.md":
		return "Requirements"
	case "design.md":
		return "Design"
	case "decisions.md":
		return "Decisions"
	case "session.md":
		return "Session"
	default:
		return file
	}
}

func renderDecisionsSummary(b *strings.Builder, content string, maxW int) {
	_, ordered := splitSectionsOrdered(content)
	count := 0
	for _, sec := range ordered {
		if sec.Header == "" {
			continue
		}
		count++
		// Extract "Chosen" and "Alternatives" from decision body.
		chosen := ""
		alternatives := ""
		reason := ""
		for line := range strings.SplitSeq(sec.Body, "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "- **Chosen:**") || strings.HasPrefix(trimmed, "**Chosen:**") {
				chosen = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(trimmed, "- "), "**Chosen:**"))
			} else if strings.HasPrefix(trimmed, "- **Alternatives:**") || strings.HasPrefix(trimmed, "**Alternatives:**") {
				alternatives = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(trimmed, "- "), "**Alternatives:**"))
			} else if strings.HasPrefix(trimmed, "- **Reason:**") || strings.HasPrefix(trimmed, "**Reason:**") {
				reason = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(trimmed, "- "), "**Reason:**"))
			}
		}
		// Strip date prefix from header if present (e.g. "[2026-03-15] Title").
		title := sec.Header
		if len(title) > 13 && title[0] == '[' {
			if idx := strings.Index(title, "] "); idx > 0 {
				title = title[idx+2:]
			}
		}
		b.WriteString("    " + truncStr(title, maxW-4) + "\n")
		if chosen != "" {
			b.WriteString("      " + dimStyle.Render("-> "+truncStr(chosen, maxW-9)) + "\n")
		}
		if alternatives != "" {
			b.WriteString("      " + dimStyle.Render("vs "+truncStr(alternatives, maxW-9)) + "\n")
		}
		if reason != "" && chosen == "" {
			b.WriteString("      " + dimStyle.Render(truncStr(reason, maxW-6)) + "\n")
		}
		if count >= 5 {
			remaining := len(ordered) - count
			if remaining > 0 {
				b.WriteString(dimStyle.Render(fmt.Sprintf("    ... +%d more", remaining)) + "\n")
			}
			break
		}
	}
	if count == 0 {
		b.WriteString("    " + dimStyle.Render("(no decisions)") + "\n")
	}
}

func renderSessionSummary(b *strings.Builder, content string, maxW int) {
	parsed := parseSessionSections(content)

	b.WriteString("    " + styledStatus(parsed.status))
	if parsed.focus != "" {
		b.WriteString("  " + truncStr(parsed.focus, maxW-20))
	}
	b.WriteString("\n")

	if parsed.hasBlocker {
		b.WriteString("    " + blockerStyle.Render("! "+truncStr(parsed.blockerText, maxW-6)) + "\n")
	}

	// Progress from next steps.
	done := 0
	for _, s := range parsed.nextSteps {
		if s.Done {
			done++
		}
	}
	if len(parsed.nextSteps) > 0 {
		b.WriteString(dimStyle.Render(fmt.Sprintf("    steps: %d/%d done", done, len(parsed.nextSteps))) + "\n")
	}

	if len(parsed.modFiles) > 0 {
		b.WriteString(dimStyle.Render(fmt.Sprintf("    files: %d modified", len(parsed.modFiles))) + "\n")
	}
}

func renderRequirementsSummary(b *strings.Builder, content string, maxW int) {
	// Show first few non-header, non-empty lines as summary.
	count := 0
	for line := range strings.SplitSeq(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "---") {
			continue
		}
		b.WriteString("    " + dimStyle.Render(truncStr(trimmed, maxW-4)) + "\n")
		count++
		if count >= 3 {
			break
		}
	}
	if count == 0 {
		b.WriteString("    " + dimStyle.Render("(empty)") + "\n")
	}
}

func renderDesignSummary(b *strings.Builder, content string, maxW int) {
	// Show section headers as an outline of the design (document order preserved).
	_, ordered := splitSectionsOrdered(content)
	count := 0
	for _, sec := range ordered {
		if sec.Header == "" {
			continue
		}
		b.WriteString("    " + dimStyle.Render("- "+truncStr(sec.Header, maxW-6)) + "\n")
		count++
		if count >= 5 {
			remaining := len(ordered) - count
			if remaining > 0 {
				b.WriteString(dimStyle.Render(fmt.Sprintf("    ... +%d more sections", remaining)) + "\n")
			}
			break
		}
	}
	if count == 0 {
		b.WriteString("    " + dimStyle.Render("(empty)") + "\n")
	}
}


func (m Model) activityView() string {
	var b strings.Builder
	b.WriteString("\n")
	maxW := m.width - 6

	// Timeline section — rendered as a table.
	if len(m.activityTable.Rows()) > 0 {
		b.WriteString("  " + sectionHeader.Render("Timeline") + "\n")
		b.WriteString(m.activityTable.View())
		b.WriteString("\n\n")
	}

	// Epic progress section.
	if len(m.epics) > 0 {
		b.WriteString("  " + sectionHeader.Render("Epics") + "\n")
		for _, e := range m.epics {
			status := styledStatus(e.Status)
			progBar := ""
			if e.Total > 0 {
				pct := float64(e.Completed) / float64(e.Total)
				barW := 10
				filled := int(pct * float64(barW))
				progBar = strings.Repeat("#", filled) + strings.Repeat("-", barW-filled)
				progBar += fmt.Sprintf(" %d%%", int(pct*100))
			}
			b.WriteString(fmt.Sprintf("  %-20s %s  %s\n", truncStr(e.Name, 20), progBar, status))
			// Show epic tasks.
			for _, t := range e.Tasks {
				taskStatus := styledStatus(t.Status)
				b.WriteString(fmt.Sprintf("    - %-16s %s\n", truncStr(t.Slug, 16), taskStatus))
			}
		}
		b.WriteString("\n")
	}

	// Cross-task decisions section.
	if len(m.decisions) > 0 {
		b.WriteString("  " + sectionHeader.Render("Recent Decisions") + "\n")
		for _, d := range m.decisions {
			title := truncStr(d.Title, maxW-30)
			task := dimStyle.Render(d.TaskSlug)
			b.WriteString("  " + title + "  " + task + "\n")
			if d.Chosen != "" {
				b.WriteString("    " + dimStyle.Render("-> "+truncStr(d.Chosen, maxW-7)) + "\n")
			}
		}
		b.WriteString("\n")
	}

	// Stats summary — count from both _active.md tasks and audit timeline.
	b.WriteString("  " + sectionHeader.Render("Stats") + "\n")
	activeCount := 0
	completedCount := 0
	for _, t := range m.allTasks {
		if t.Status == "completed" || t.Status == "done" {
			completedCount++
		} else {
			activeCount++
		}
	}
	// Also count completions from audit timeline (covers tasks already removed from _active.md).
	auditCompleted := 0
	for _, a := range m.activity {
		if a.Action == "spec.complete" {
			auditCompleted++
		}
	}
	if auditCompleted > completedCount {
		completedCount = auditCompleted
	}
	b.WriteString(fmt.Sprintf("  Tasks: %d active, %d completed\n", activeCount, completedCount))

	if b.Len() < 3 {
		return "\n" + dimStyle.Render("  no activity yet")
	}

	return b.String()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// extractKnowledgeTitle extracts the best title for a knowledge entry,
// preferring structured data fields over label parsing.
func extractKnowledgeTitle(k KnowledgeEntry) string {
	if k.Structured != "" {
		var raw map[string]any
		if json.Unmarshal([]byte(k.Structured), &raw) == nil {
			if t, ok := raw["title"].(string); ok && t != "" {
				return t
			}
			if t, ok := raw["text"].(string); ok && t != "" {
				return t
			}
		}
	}
	title, _ := simplifyKnowledgeLabel(k.Label)
	if len(title) < 5 {
		title = knowledgeTitle(k.Content)
	}
	return title
}

// renderKnowledgeDetailNoTitle renders a knowledge entry without the leading
// heading, since the overlay already shows the title in the header bar.
func renderKnowledgeDetailNoTitle(k KnowledgeEntry) string {
	full := renderKnowledgeDetail(k)
	// Strip leading heading line (any level: #, ##, ###) if present.
	if strings.HasPrefix(full, "#") {
		if _, after, found := strings.Cut(full, "\n"); found {
			return strings.TrimLeft(after, "\n")
		}
	}
	return full
}

// renderKnowledgeDetail renders a knowledge entry for the overlay,
// using structured data fields when available.
func renderKnowledgeDetail(k KnowledgeEntry) string {
	if k.Structured == "" {
		return formatKnowledgeContent(k.Content)
	}

	var raw map[string]any
	if json.Unmarshal([]byte(k.Structured), &raw) != nil {
		return k.Content
	}

	var b strings.Builder

	// writeSection writes a markdown section with proper spacing.
	// Ensures a blank line between heading and content, and between
	// prose text and bullet lists within the content.
	writeSection := func(heading, body string) {
		b.WriteString("## " + heading + "\n\n")
		b.WriteString(ensureListSpacing(body))
		b.WriteString("\n\n")
	}

	switch k.SubType {
	case "decision":
		if v, _ := raw["title"].(string); v != "" {
			b.WriteString("# " + v + "\n\n")
		}
		if v, _ := raw["context"].(string); v != "" {
			writeSection("Context", v)
		}
		if v, _ := raw["decision"].(string); v != "" {
			writeSection("Decision", v)
		}
		if v, _ := raw["reasoning"].(string); v != "" {
			writeSection("Reasoning", v)
		}
		if alts, ok := raw["alternatives"].([]any); ok && len(alts) > 0 {
			b.WriteString("## Alternatives\n\n")
			for _, a := range alts {
				b.WriteString("- " + fmt.Sprint(a) + "\n")
			}
			b.WriteString("\n")
		}
		if v, _ := raw["status"].(string); v != "" {
			b.WriteString("---\n\n**Status:** " + v + "\n")
		}

	case "pattern":
		if v, _ := raw["title"].(string); v != "" {
			b.WriteString("# " + v + "\n\n")
		}
		if v, _ := raw["context"].(string); v != "" {
			writeSection("Context", v)
		}
		if v, _ := raw["pattern"].(string); v != "" {
			writeSection("Pattern", v)
		}
		if v, _ := raw["applicationConditions"].(string); v != "" {
			writeSection("When to Apply", v)
		}
		if v, _ := raw["expectedOutcomes"].(string); v != "" {
			writeSection("Expected Outcomes", v)
		}
		if v, _ := raw["status"].(string); v != "" {
			b.WriteString("---\n\n**Status:** " + v + "\n")
		}

	case "rule":
		if v, _ := raw["text"].(string); v != "" {
			b.WriteString("# " + v + "\n\n")
		}
		if v, _ := raw["category"].(string); v != "" {
			b.WriteString("**Category:** " + v + "\n\n")
		}
		if v, _ := raw["priority"].(string); v != "" {
			b.WriteString("**Priority:** " + v + "\n\n")
		}
		if v, _ := raw["rationale"].(string); v != "" {
			writeSection("Rationale", v)
		}
		if v, _ := raw["status"].(string); v != "" {
			b.WriteString("---\n\n**Status:** " + v + "\n")
		}

	default:
		return formatKnowledgeContent(k.Content)
	}

	if b.Len() == 0 {
		return k.Content
	}
	return b.String()
}

// ensureListSpacing inserts a blank line before a bullet list
// that immediately follows a non-blank, non-bullet line.
// This ensures glamour renders the list as a proper markdown list.
func ensureListSpacing(s string) string {
	lines := strings.Split(s, "\n")
	var out strings.Builder
	for i, line := range lines {
		if i > 0 && strings.HasPrefix(line, "- ") {
			prev := lines[i-1]
			if prev != "" && !strings.HasPrefix(prev, "- ") {
				out.WriteByte('\n')
			}
		}
		out.WriteString(line)
		if i < len(lines)-1 {
			out.WriteByte('\n')
		}
	}
	return out.String()
}

// knowledgeTitle extracts a human-readable title from knowledge content.
func knowledgeTitle(content string) string {
	trimmed := strings.TrimSpace(content)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		var ch struct {
			Goal string `json:"goal"`
		}
		if json.Unmarshal([]byte(trimmed), &ch) == nil && ch.Goal != "" {
			return ch.Goal
		}
	}
	return firstContentLine(content)
}

// formatKnowledgeContent renders knowledge content for the overlay.
func formatKnowledgeContent(content string) string {
	trimmed := strings.TrimSpace(content)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return content
	}
	var ch map[string]any
	if json.Unmarshal([]byte(trimmed), &ch) != nil {
		return content
	}
	var sb strings.Builder
	if v, ok := ch["goal"].(string); ok && v != "" {
		sb.WriteString("## Goal\n" + v + "\n\n")
	}
	if v, ok := ch["status"].(string); ok {
		sb.WriteString("**Status:** " + v + "\n\n")
	}
	if v, ok := ch["decisions"].([]any); ok && len(v) > 0 {
		sb.WriteString("## Decisions\n")
		for _, d := range v {
			sb.WriteString("- " + fmt.Sprint(d) + "\n")
		}
		sb.WriteString("\n")
	}
	if v, ok := ch["modified_files"].([]any); ok && len(v) > 0 {
		sb.WriteString("## Modified Files\n")
		for _, f := range v {
			sb.WriteString("- " + fmt.Sprint(f) + "\n")
		}
		sb.WriteString("\n")
	}
	if sb.Len() == 0 {
		return content
	}
	return sb.String()
}

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

// clipboardMsg is sent after clipboard operation completes.
type clipboardMsg struct{ err error }

// copyToClipboard copies text to system clipboard via pbcopy (macOS).
func copyToClipboard(text string) tea.Cmd {
	return func() tea.Msg {
		cmd := exec.Command("pbcopy")
		cmd.Stdin = strings.NewReader(text)
		err := cmd.Run()
		return clipboardMsg{err}
	}
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

func (m Model) renderMarkdown(content string) string {
	if m.mdRenderer == nil {
		return content
	}
	rendered, err := m.mdRenderer.Render(content)
	if err != nil {
		return content
	}
	return strings.TrimSpace(rendered)
}

func simplifyKnowledgeLabel(label string) (title, context string) {
	parts := strings.Split(label, " > ")
	if len(parts) <= 1 {
		return label, ""
	}
	title = parts[len(parts)-1]
	// Skip numeric ID prefix (first part).
	start := 0
	if len(parts[0]) > 0 && parts[0][0] >= '0' && parts[0][0] <= '9' {
		start = 1
	}
	if start < len(parts)-1 {
		context = strings.Join(parts[start:len(parts)-1], " / ")
	}
	return
}

func formatAuditAction(action string) string {
	switch action {
	case "spec.init":
		return "created"
	case "spec.delete":
		return "deleted"
	case "spec.complete":
		return "completed"
	case "review.submit":
		return "reviewed"
	case "epic.link":
		return "linked"
	default:
		return action
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
