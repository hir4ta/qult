package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/progress"
	"charm.land/lipgloss/v2"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/install"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// TUI messages.
type (
	docProgressMsg   struct{ done, total int }
	embedProgressMsg struct{ done, total int }
	seedDoneMsg      struct {
		result install.SeedResult
		err    error
	}
	tickMsg time.Time
)

type setupPhase int

const (
	phaseInit setupPhase = iota
	phaseSeeding
	phaseEmbedding
	phaseDone
	phaseError
)

type setupModel struct {
	phase     setupPhase
	docsTotal int
	docsDone  int
	embedTot  int
	embedDone int
	startTime time.Time
	err       error
	result    install.SeedResult

	progress progress.Model
	cancel   context.CancelFunc // cancels the ApplySeed goroutine
}

var (
	titleStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7571F9"))
	doneStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("#04B575"))
	errStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("#FF4672"))
	dimStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("#626262"))
)

func newSetupModel() setupModel {
	p := progress.New(
		progress.WithDefaultBlend(),
		progress.WithWidth(40),
	)
	return setupModel{
		phase:     phaseInit,
		startTime: time.Now(),
		progress:  p,
	}
}

func (m setupModel) Init() tea.Cmd {
	return tea.Tick(500*time.Millisecond, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func (m setupModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if msg.String() == "ctrl+c" || msg.String() == "q" {
			if m.cancel != nil {
				m.cancel()
			}
			return m, tea.Quit
		}

	case docProgressMsg:
		m.phase = phaseSeeding
		m.docsDone = msg.done
		m.docsTotal = msg.total
		return m, nil

	case embedProgressMsg:
		m.phase = phaseEmbedding
		m.embedDone = msg.done
		m.embedTot = msg.total
		var pct float64
		if msg.total > 0 {
			pct = float64(msg.done) / float64(msg.total)
		}
		cmd := m.progress.SetPercent(pct)
		return m, cmd

	case seedDoneMsg:
		if msg.err != nil {
			m.phase = phaseError
			m.err = msg.err
			return m, tea.Quit
		}
		m.phase = phaseDone
		m.result = msg.result
		cmd := m.progress.SetPercent(1.0)
		return m, tea.Sequence(cmd, tea.Quit)

	case tickMsg:
		return m, tea.Tick(500*time.Millisecond, func(t time.Time) tea.Msg {
			return tickMsg(t)
		})

	case progress.FrameMsg:
		pm, cmd := m.progress.Update(msg)
		m.progress = pm
		return m, cmd
	}

	return m, nil
}

func (m setupModel) View() tea.View {
	var b strings.Builder

	b.WriteString("\n  " + titleStyle.Render("alfred setup") + "\n\n")

	// Phase 1: Seeding docs.
	switch {
	case m.phase == phaseInit:
		b.WriteString("  Seeding docs " + dimStyle.Render("waiting...") + "\n")
	case m.phase == phaseSeeding:
		b.WriteString(fmt.Sprintf("  Seeding docs %s %d/%d\n",
			dimStyle.Render("·····"),
			m.docsDone, m.docsTotal))
	default:
		b.WriteString(fmt.Sprintf("  Seeding docs %s %d/%d %s\n",
			dimStyle.Render("·····"),
			m.docsTotal, m.docsTotal,
			doneStyle.Render("✓")))
	}

	// Phase 2: Embedding.
	switch {
	case m.phase < phaseEmbedding:
		// not started yet
	case m.phase == phaseEmbedding:
		b.WriteString(fmt.Sprintf("  Generating embeddings ··· %d/%d\n",
			m.embedDone, m.embedTot))
		b.WriteString("  " + m.progress.View() + "\n")
	default:
		b.WriteString(fmt.Sprintf("  Generating embeddings ··· %d/%d %s\n",
			m.embedTot, m.embedTot,
			doneStyle.Render("✓")))
	}

	// Elapsed time.
	elapsed := time.Since(m.startTime).Round(time.Second)
	b.WriteString("\n")

	if m.phase == phaseDone {
		total := m.result.Applied + m.result.Unchanged
		b.WriteString(fmt.Sprintf("  %s (%s)\n",
			doneStyle.Render("✓ Setup complete"),
			elapsed))
		b.WriteString(fmt.Sprintf("  %d docs, %d embeddings\n\n",
			total, m.result.Embedded))
	} else if m.phase == phaseError {
		b.WriteString(fmt.Sprintf("  %s %v\n\n",
			errStyle.Render("✗ Error:"), m.err))
	} else {
		b.WriteString(fmt.Sprintf("  %s %s\n",
			dimStyle.Render("Elapsed:"), elapsed))
	}

	return tea.NewView(b.String())
}

func runSetup() error {
	emb, err := embedder.NewEmbedder()
	if err != nil {
		return fmt.Errorf("VOYAGE_API_KEY is required: %w", err)
	}

	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("failed to open store: %w", err)
	}
	defer st.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	m := newSetupModel()
	m.cancel = cancel
	p := tea.NewProgram(m)

	go func() {
		prog := &install.SeedProgress{
			OnDocUpsert: func(done, total int) {
				p.Send(docProgressMsg{done, total})
			},
			OnEmbedBatch: func(done, total int) {
				p.Send(embedProgressMsg{done, total})
			},
		}
		result, err := install.ApplySeed(ctx, st, emb, prog)
		p.Send(seedDoneMsg{result, err})
	}()

	_, err = p.Run()
	return err
}
