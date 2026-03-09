package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/progress"
	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/stopwatch"
	"charm.land/bubbles/v2/textinput"
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
)

type setupPhase int

const (
	phaseKeyPrompt setupPhase = iota
	phaseInit
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
	err       error
	result    install.SeedResult
	ftsOnly   bool // skip embeddings

	keyInput  textinput.Model
	spinner   spinner.Model
	progress  progress.Model
	stopwatch stopwatch.Model
	cancel    context.CancelFunc
	keyReady  chan struct{} // closed when key prompt is resolved
	keyClosed *atomic.Bool  // guards double-close
}

var (
	titleStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7571F9"))
	doneStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("#04B575"))
	errStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("#FF4672"))
	dimStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("#626262"))
)

func newSetupModel(hasKey bool) setupModel {
	p := progress.New(
		progress.WithDefaultBlend(),
		progress.WithWidth(40),
	)
	s := spinner.New(spinner.WithSpinner(spinner.Dot))
	s.Style = dimStyle

	ti := textinput.New()
	ti.Placeholder = "sk-voyage-..."
	ti.SetWidth(50)
	ti.CharLimit = 256
	ti.EchoMode = textinput.EchoPassword

	sw := stopwatch.New(stopwatch.WithInterval(time.Second))

	phase := phaseKeyPrompt
	keyReady := make(chan struct{})
	keyClosed := &atomic.Bool{}
	if hasKey {
		phase = phaseInit
		close(keyReady)
		keyClosed.Store(true)
	}

	return setupModel{
		phase:     phase,
		spinner:   s,
		progress:  p,
		keyInput:  ti,
		stopwatch: sw,
		keyReady:  keyReady,
		keyClosed: keyClosed,
	}
}

func (m setupModel) Init() tea.Cmd {
	if m.phase == phaseKeyPrompt {
		return m.keyInput.Focus()
	}
	return tea.Batch(
		m.spinner.Tick,
		m.stopwatch.Start(),
	)
}

func (m setupModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		key := msg.String()
		if key == "ctrl+c" {
			if m.cancel != nil {
				m.cancel()
			}
			return m, tea.Quit
		}

		if m.phase == phaseKeyPrompt {
			switch key {
			case "enter":
				val := strings.TrimSpace(m.keyInput.Value())
				if val != "" {
					os.Setenv("VOYAGE_API_KEY", val)
					// Best-effort persist to shell profile; key is already set for this process.
					_ = saveEnvToProfile("VOYAGE_API_KEY", val)
				} else {
					m.ftsOnly = true
				}
				m.phase = phaseInit
				if m.keyClosed.CompareAndSwap(false, true) {
					close(m.keyReady)
				}
				return m, tea.Batch(
					m.spinner.Tick,
					m.stopwatch.Start(),
				)
			case "esc":
				m.ftsOnly = true
				m.phase = phaseInit
				if m.keyClosed.CompareAndSwap(false, true) {
					close(m.keyReady)
				}
				return m, tea.Batch(
					m.spinner.Tick,
					m.stopwatch.Start(),
				)
			}
		}

		if key == "q" && m.phase != phaseKeyPrompt {
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
		return m, tea.Sequence(cmd, m.stopwatch.Stop(), tea.Quit)

	case stopwatch.TickMsg, stopwatch.StartStopMsg, stopwatch.ResetMsg:
		var cmd tea.Cmd
		m.stopwatch, cmd = m.stopwatch.Update(msg)
		return m, cmd

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

	if m.phase == phaseKeyPrompt {
		var cmd tea.Cmd
		m.keyInput, cmd = m.keyInput.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m setupModel) View() tea.View {
	h := newHelp()
	var b strings.Builder

	b.WriteString("\n  " + titleStyle.Render("⚡ alfred init") + "\n\n")

	// Key prompt phase.
	if m.phase == phaseKeyPrompt {
		b.WriteString("  Voyage API Key (for semantic search + reranking):\n\n")
		b.WriteString("  " + m.keyInput.View() + "\n\n")
		b.WriteString("  " + dimStyle.Render("Get a key at https://dash.voyageai.com/") + "\n\n")
		keys := simpleKeyMap{keyEnter, keyEsc}
		b.WriteString("  " + h.View(keys) + "\n")
		return tea.NewView(b.String())
	}

	elapsed := m.stopwatch.View()

	// FTS-only mode banner.
	if m.ftsOnly {
		b.WriteString("  " + dimStyle.Render("FTS-only mode (no vector search)") + "\n\n")
	}

	// Phase 1: Seeding docs.
	seedLabel := "[1/2]"
	if m.ftsOnly {
		seedLabel = "[1/1]"
	}
	switch {
	case m.phase == phaseInit:
		b.WriteString(fmt.Sprintf("  %s Seeding docs %s\n", seedLabel, m.spinner.View()))
	case m.phase == phaseSeeding:
		b.WriteString(fmt.Sprintf("  %s Seeding docs %s %d/%d\n",
			seedLabel,
			dimStyle.Render("···"),
			m.docsDone, m.docsTotal))
	default:
		b.WriteString(fmt.Sprintf("  %s Seeding docs %s %d/%d %s\n",
			seedLabel,
			dimStyle.Render("···"),
			m.docsTotal, m.docsTotal,
			doneStyle.Render("✓")))
	}

	// Phase 2: Embedding (skip in FTS-only mode).
	if !m.ftsOnly {
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
	}

	// Footer.
	b.WriteString("\n")

	if m.phase == phaseDone {
		total := m.result.Applied + m.result.Unchanged
		b.WriteString(fmt.Sprintf("  %s (%s)\n",
			doneStyle.Render("✓ Setup complete"),
			elapsed))
		if m.ftsOnly {
			b.WriteString(fmt.Sprintf("  %d docs (FTS-only)\n\n", total))
		} else {
			b.WriteString(fmt.Sprintf("  %d docs, %d embeddings\n\n",
				total, m.result.Embedded))
		}
		b.WriteString("  " + dimStyle.Render("What's next:") + "\n")
		b.WriteString("  " + dimStyle.Render("  Ask about Claude Code  → alfred injects relevant docs automatically") + "\n")
		b.WriteString("  " + dimStyle.Render("  /alfred:setup          → project-wide configuration wizard") + "\n")
		b.WriteString("  " + dimStyle.Render("  /alfred:plan <task>    → start a spec-driven development task") + "\n")
		b.WriteString("  " + dimStyle.Render("  alfred status          → check system state anytime") + "\n\n")
	} else if m.phase == phaseError {
		b.WriteString(fmt.Sprintf("  %s %v\n\n",
			errStyle.Render("✗ Error:"), m.err))
	} else {
		b.WriteString(fmt.Sprintf("  %s\n\n",
			dimStyle.Render(elapsed+" elapsed")))
		keys := simpleKeyMap{keyForceQuit}
		b.WriteString("  " + h.View(keys) + "\n")
	}

	return tea.NewView(b.String())
}

func runSetup() error {
	hasKey := os.Getenv("VOYAGE_API_KEY") != ""

	m := newSetupModel(hasKey)

	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("failed to open store: %w", err)
	}
	defer st.Close()

	// Clean up expired docs before seeding new ones.
	if n, err := st.DeleteExpiredDocs(context.Background()); err == nil && n > 0 {
		fmt.Fprintf(os.Stderr, "  Cleaned up %d expired docs\n", n)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	m.cancel = cancel
	p := tea.NewProgram(m)

	go func() {
		// Wait for key prompt resolution (immediate if key was already set).
		select {
		case <-m.keyReady:
		case <-ctx.Done():
			return
		}

		var emb *embedder.Embedder
		if e, err := embedder.NewEmbedder(); err == nil {
			emb = e
		}

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

	// Install alfred rules to ~/.claude/rules/ for global loading.
	if n, rErr := install.InstallUserRules(); rErr != nil {
		fmt.Fprintf(os.Stderr, "  Warning: could not install rules: %v\n", rErr)
	} else if n > 0 {
		fmt.Fprintf(os.Stderr, "  ✓ Updated %d rules in ~/.claude/rules/\n", n)
	}

	return nil
}
