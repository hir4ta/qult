package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/progress"
	"charm.land/bubbles/v2/spinner"
	"charm.land/lipgloss/v2"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/install"
	"github.com/hir4ta/claude-alfred/internal/store"
)

const sourcesTemplate = `# alfred custom knowledge sources
# Add your tech stack documentation URLs here.
# Run ` + "`alfred harvest`" + ` after editing to crawl and generate embeddings.
#
# Example:
#   sources:
#     - name: Next.js
#       url: https://nextjs.org/docs
#     - name: Go
#       url: https://go.dev
#       path_prefix: /doc/
#
# Discovery: llms.txt is tried first, then sitemap.xml, then single page.
# Use the knowledge-curator agent to add sources interactively.

sources: []
`

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

	spinner  spinner.Model
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
	s := spinner.New(spinner.WithSpinner(spinner.Dot))
	s.Style = dimStyle
	return setupModel{
		phase:     phaseInit,
		startTime: time.Now(),
		spinner:   s,
		progress:  p,
	}
}

func (m setupModel) Init() tea.Cmd {
	return tea.Batch(
		m.spinner.Tick,
		tea.Tick(500*time.Millisecond, func(t time.Time) tea.Msg {
			return tickMsg(t)
		}),
	)
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

	case spinner.TickMsg:
		if m.phase == phaseInit || m.phase == phaseSeeding {
			sm, cmd := m.spinner.Update(msg)
			m.spinner = sm
			return m, cmd
		}
		return m, nil

	case progress.FrameMsg:
		pm, cmd := m.progress.Update(msg)
		m.progress = pm
		return m, cmd
	}

	return m, nil
}

func (m setupModel) View() tea.View {
	var b strings.Builder

	b.WriteString("\n  " + titleStyle.Render("⚡ alfred setup") + "\n\n")

	elapsed := time.Since(m.startTime).Round(time.Second)

	// Phase 1: Seeding docs.
	switch {
	case m.phase == phaseInit:
		b.WriteString("  [1/2] Seeding docs " + m.spinner.View() + "\n")
	case m.phase == phaseSeeding:
		b.WriteString(fmt.Sprintf("  [1/2] Seeding docs %s %d/%d\n",
			dimStyle.Render("···"),
			m.docsDone, m.docsTotal))
	default:
		b.WriteString(fmt.Sprintf("  [1/2] Seeding docs %s %d/%d %s\n",
			dimStyle.Render("···"),
			m.docsTotal, m.docsTotal,
			doneStyle.Render("✓")))
	}

	// Phase 2: Embedding.
	switch {
	case m.phase < phaseEmbedding:
		// not started yet
	case m.phase == phaseEmbedding:
		var pct float64
		if m.embedTot > 0 {
			pct = float64(m.embedDone) / float64(m.embedTot) * 100
		}
		b.WriteString(fmt.Sprintf("  [2/2] Generating embeddings %s %d/%d\n",
			dimStyle.Render("···"),
			m.embedDone, m.embedTot))
		b.WriteString(fmt.Sprintf("        %s %s\n",
			m.progress.View(),
			dimStyle.Render(fmt.Sprintf("%.0f%%", pct))))
	default:
		b.WriteString(fmt.Sprintf("  [2/2] Generating embeddings %s %d/%d %s\n",
			dimStyle.Render("···"),
			m.embedTot, m.embedTot,
			doneStyle.Render("✓")))
	}

	// Footer.
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
		b.WriteString(fmt.Sprintf("  %s\n",
			dimStyle.Render(fmt.Sprintf("%s elapsed", elapsed))))
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
	if err != nil {
		return err
	}

	// Create sources.yaml template if it doesn't exist.
	sourcesPath := install.DefaultSourcesPath()
	if _, statErr := os.Stat(sourcesPath); os.IsNotExist(statErr) {
		if writeErr := os.WriteFile(sourcesPath, []byte(sourcesTemplate), 0o644); writeErr == nil {
			fmt.Printf("\n  Created %s\n", sourcesPath)
			fmt.Printf("  Add your tech stack docs, then run `alfred harvest` to ingest.\n")
		}
	}

	return nil
}
