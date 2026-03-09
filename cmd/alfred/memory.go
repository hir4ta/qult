package main

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/paginator"
	"charm.land/lipgloss/v2"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// defaultMemoryMaxAgeDays is the default maximum age for memory pruning.
const defaultMemoryMaxAgeDays = 180

func memoryMaxAgeDays() int {
	if v := os.Getenv("ALFRED_MEMORY_MAX_AGE_DAYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return defaultMemoryMaxAgeDays
}

func runMemory() error {
	if len(os.Args) < 3 {
		fmt.Println(`alfred memory — manage persistent memories

Commands:
  prune [--confirm]    Remove old memories (default: interactive preview)
  stats                Show memory statistics

Options:
  --max-age DAYS       Maximum age in days (default: 180, env: ALFRED_MEMORY_MAX_AGE_DAYS)`)
		return nil
	}

	switch os.Args[2] {
	case "prune":
		return runMemoryPrune()
	case "stats":
		return runMemoryStats()
	default:
		return fmt.Errorf("unknown memory command: %s", os.Args[2])
	}
}

// pruneItem is a memory entry displayed in the paginator.
type pruneItem struct {
	date        string
	sectionPath string
}

type pruneModel struct {
	items     []pruneItem
	paginator paginator.Model
	total     int
	maxAge    int
	st        *store.Store
	cutoff    string
	deleted   int
	deleting  bool
	done      bool
	err       error
}

func newPruneModel(items []pruneItem, total, maxAge int, st *store.Store, cutoff string) pruneModel {
	p := paginator.New()
	p.Type = paginator.Dots
	p.PerPage = 10
	p.SetTotalPages(len(items))
	p.ActiveDot = lipgloss.NewStyle().Foreground(lipgloss.Color("#7571F9")).Render("●")
	p.InactiveDot = lipgloss.NewStyle().Foreground(lipgloss.Color("#626262")).Render("○")

	return pruneModel{
		items:     items,
		paginator: p,
		total:     total,
		maxAge:    maxAge,
		st:        st,
		cutoff:    cutoff,
	}
}

func (m pruneModel) Init() tea.Cmd { return nil }

// pruneDeletedMsg is sent when the async delete completes.
type pruneDeletedMsg struct {
	deleted int
	err     error
}

func (m pruneModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if m.done {
		switch msg.(type) {
		case tea.KeyPressMsg:
			return m, tea.Quit
		}
		return m, nil
	}

	switch msg := msg.(type) {
	case pruneDeletedMsg:
		m.deleted = msg.deleted
		m.err = msg.err
		m.deleting = false
		m.done = true
		return m, nil

	case tea.KeyPressMsg:
		if m.deleting {
			return m, nil // ignore input during deletion
		}
		switch msg.String() {
		case "q", "ctrl+c", "esc":
			return m, tea.Quit
		case "enter", "y":
			m.deleting = true
			st := m.st
			cutoff := m.cutoff
			return m, func() tea.Msg {
				deleted, err := st.DeleteMemoriesBefore(context.Background(), cutoff)
				return pruneDeletedMsg{deleted: int(deleted), err: err}
			}
		}
	}
	var cmd tea.Cmd
	m.paginator, cmd = m.paginator.Update(msg)
	return m, cmd
}

func (m pruneModel) View() tea.View {
	warnStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#FF4672"))
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#626262"))
	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7571F9"))
	okStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#04B575"))

	var b strings.Builder

	b.WriteString("\n  " + headerStyle.Render("alfred memory prune") + "\n\n")

	if m.deleting {
		b.WriteString("  " + mutedStyle.Render("Deleting...") + "\n")
		return tea.NewView(b.String())
	}

	if m.done {
		if m.err != nil {
			b.WriteString(fmt.Sprintf("  %s %v\n\n", warnStyle.Render("✗ Error:"), m.err))
		} else {
			b.WriteString(fmt.Sprintf("  %s Deleted %d memories older than %d days.\n\n",
				okStyle.Render("✓"), m.deleted, m.maxAge))
		}
		b.WriteString("  " + mutedStyle.Render("Press any key to exit") + "\n")
		return tea.NewView(b.String())
	}

	b.WriteString(fmt.Sprintf("  Found %s older than %d days:\n\n",
		warnStyle.Render(fmt.Sprintf("%d memories", m.total)), m.maxAge))

	// Paginated items.
	start, end := m.paginator.GetSliceBounds(len(m.items))
	for _, item := range m.items[start:end] {
		b.WriteString(fmt.Sprintf("  %s  %s\n",
			mutedStyle.Render(item.date), item.sectionPath))
	}

	b.WriteString("\n  " + m.paginator.View() + "\n\n")

	h := newHelp()
	enterKey := keyEnter
	enterKey.SetHelp("enter/y", "delete")
	b.WriteString("  " + h.View(simpleKeyMap{keyLeft, keyRight, enterKey, keyQuit}) + "\n")

	return tea.NewView(b.String())
}

func runMemoryPrune() error {
	confirm := slices.Contains(os.Args[2:], "--confirm")
	maxAge := memoryMaxAgeDays()

	// Parse --max-age flag.
	for i := 2; i < len(os.Args)-1; i++ {
		if os.Args[i] == "--max-age" {
			if n, err := strconv.Atoi(os.Args[i+1]); err == nil && n > 0 {
				maxAge = n
			}
		}
	}

	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	ctx := context.Background()
	cutoff := time.Now().AddDate(0, 0, -maxAge).Format(time.RFC3339)

	count, err := st.CountDocsBySourceTypeAndAge(ctx, store.SourceMemory, cutoff)
	if err != nil {
		return fmt.Errorf("count: %w", err)
	}

	if count == 0 {
		fmt.Printf("No memories older than %d days.\n", maxAge)
		return nil
	}

	// Direct delete mode (non-interactive).
	if confirm {
		deleted, err := st.DeleteMemoriesBefore(ctx, cutoff)
		if err != nil {
			return fmt.Errorf("delete: %w", err)
		}
		fmt.Printf("Deleted %d memories older than %d days.\n", deleted, maxAge)
		return nil
	}

	// Load all items for paginated preview.
	items, err := st.ListMemoriesBefore(ctx, cutoff, int(count))
	if err != nil {
		return fmt.Errorf("list: %w", err)
	}

	var pruneItems []pruneItem
	for _, item := range items {
		dateStr := item.CrawledAt
		if len(item.CrawledAt) >= 10 {
			dateStr = item.CrawledAt[:10]
		}
		pruneItems = append(pruneItems, pruneItem{date: dateStr, sectionPath: item.SectionPath})
	}

	m := newPruneModel(pruneItems, int(count), maxAge, st, cutoff)
	_, err = tea.NewProgram(m).Run()
	return err
}

func runMemoryStats() error {
	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	ctx := context.Background()

	total, err := st.CountDocsBySourceType(ctx, store.SourceMemory)
	if err != nil {
		return fmt.Errorf("count: %w", err)
	}

	fmt.Printf("Total memories: %d\n", total)

	stats, err := st.MemoryStatsByProject(ctx, 0)
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}

	fmt.Println()
	for _, s := range stats {
		oldDate := s.Oldest
		if len(s.Oldest) >= 10 {
			oldDate = s.Oldest[:10]
		}
		newDate := s.Newest
		if len(s.Newest) >= 10 {
			newDate = s.Newest[:10]
		}
		fmt.Printf("  %-30s %3d memories  (%s — %s)\n", s.Project, s.Count, oldDate, newDate)
	}
	return nil
}
