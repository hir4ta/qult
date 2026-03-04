package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/progress"
	"charm.land/bubbles/v2/spinner"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/install"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// harvest TUI messages.
type (
	crawlDocsMsg   struct{ done, total int }
	crawlBlogMsg   struct{ done, total int }
	crawlCustomMsg struct {
		name        string
		done, total int
	}
	crawlDoneMsg struct {
		sf  *install.SeedFile
		err error
	}
	harvestDocMsg   struct{ done, total int }
	harvestEmbedMsg struct{ done, total int }
	harvestDoneMsg  struct {
		result install.SeedResult
		err    error
	}
)

type harvestPhase int

const (
	harvestCrawling harvestPhase = iota
	harvestSeeding
	harvestEmbedding
	harvestComplete
	harvestError
)

type harvestModel struct {
	phase     harvestPhase
	startTime time.Time
	err       error
	result    install.SeedResult

	// crawl progress
	crawlDocsDone  int
	crawlDocsTotal int
	crawlBlogDone  int
	crawlBlogTotal int
	customName     string
	customDone     int
	customTotal    int

	// seed progress
	docsDone  int
	docsTotal int
	embedDone int
	embedTot  int

	spinner  spinner.Model
	progress progress.Model
	cancel   context.CancelFunc
}

func newHarvestModel() harvestModel {
	p := progress.New(
		progress.WithDefaultBlend(),
		progress.WithWidth(40),
	)
	s := spinner.New(spinner.WithSpinner(spinner.Dot))
	s.Style = dimStyle
	return harvestModel{
		phase:     harvestCrawling,
		startTime: time.Now(),
		spinner:   s,
		progress:  p,
	}
}

func (m harvestModel) Init() tea.Cmd {
	return tea.Batch(
		m.spinner.Tick,
		tea.Tick(500*time.Millisecond, func(t time.Time) tea.Msg {
			return tickMsg(t)
		}),
	)
}

func (m harvestModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if msg.String() == "ctrl+c" || msg.String() == "q" {
			if m.cancel != nil {
				m.cancel()
			}
			return m, tea.Quit
		}

	case crawlDocsMsg:
		m.crawlDocsDone = msg.done
		m.crawlDocsTotal = msg.total
		return m, nil

	case crawlBlogMsg:
		m.crawlBlogDone = msg.done
		m.crawlBlogTotal = msg.total
		return m, nil

	case crawlCustomMsg:
		m.customName = msg.name
		m.customDone = msg.done
		m.customTotal = msg.total
		return m, nil

	case crawlDoneMsg:
		if msg.err != nil && msg.sf == nil {
			m.phase = harvestError
			m.err = msg.err
			return m, tea.Quit
		}
		// Crawl done, transition to seeding phase.
		// The seeding goroutine is started by the caller.
		m.phase = harvestSeeding
		return m, nil

	case harvestDocMsg:
		m.phase = harvestSeeding
		m.docsDone = msg.done
		m.docsTotal = msg.total
		return m, nil

	case harvestEmbedMsg:
		m.phase = harvestEmbedding
		m.embedDone = msg.done
		m.embedTot = msg.total
		var pct float64
		if msg.total > 0 {
			pct = float64(msg.done) / float64(msg.total)
		}
		cmd := m.progress.SetPercent(pct)
		return m, cmd

	case harvestDoneMsg:
		if msg.err != nil {
			m.phase = harvestError
			m.err = msg.err
			return m, tea.Quit
		}
		m.phase = harvestComplete
		m.result = msg.result
		cmd := m.progress.SetPercent(1.0)
		return m, tea.Sequence(cmd, tea.Quit)

	case tickMsg:
		return m, tea.Tick(500*time.Millisecond, func(t time.Time) tea.Msg {
			return tickMsg(t)
		})

	case spinner.TickMsg:
		if m.phase <= harvestSeeding {
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

func (m harvestModel) View() tea.View {
	var b strings.Builder

	b.WriteString("\n  " + titleStyle.Render("⚡ alfred harvest") + "\n\n")

	elapsed := time.Since(m.startTime).Round(time.Second)

	// Phase 1: Crawling.
	switch {
	case m.phase == harvestCrawling:
		if m.crawlDocsTotal > 0 {
			b.WriteString(fmt.Sprintf("  [1/3] Crawling docs %s %d/%d\n",
				m.spinner.View(), m.crawlDocsDone, m.crawlDocsTotal))
		} else {
			b.WriteString("  [1/3] Crawling docs " + m.spinner.View() + "\n")
		}
		if m.crawlBlogTotal > 0 {
			b.WriteString(fmt.Sprintf("        Crawling blog %s %d/%d\n",
				dimStyle.Render("···"), m.crawlBlogDone, m.crawlBlogTotal))
		}
		if m.customTotal > 0 {
			b.WriteString(fmt.Sprintf("        Crawling %s %s %d/%d\n",
				m.customName, dimStyle.Render("···"), m.customDone, m.customTotal))
		}
	default:
		total := m.crawlDocsTotal + m.crawlBlogTotal + m.customTotal
		b.WriteString(fmt.Sprintf("  [1/3] Crawling %s %d pages %s\n",
			dimStyle.Render("···"), total, doneStyle.Render("✓")))
	}

	// Phase 2: Seeding docs.
	switch {
	case m.phase < harvestSeeding:
		// not started
	case m.phase == harvestSeeding:
		b.WriteString(fmt.Sprintf("  [2/3] Seeding docs %s %d/%d\n",
			dimStyle.Render("···"), m.docsDone, m.docsTotal))
	default:
		b.WriteString(fmt.Sprintf("  [2/3] Seeding docs %s %d/%d %s\n",
			dimStyle.Render("···"), m.docsTotal, m.docsTotal, doneStyle.Render("✓")))
	}

	// Phase 3: Embedding.
	switch {
	case m.phase < harvestEmbedding:
		// not started
	case m.phase == harvestEmbedding:
		var pct float64
		if m.embedTot > 0 {
			pct = float64(m.embedDone) / float64(m.embedTot) * 100
		}
		b.WriteString(fmt.Sprintf("  [3/3] Generating embeddings %s %d/%d\n",
			dimStyle.Render("···"), m.embedDone, m.embedTot))
		b.WriteString(fmt.Sprintf("        %s %s\n",
			m.progress.View(), dimStyle.Render(fmt.Sprintf("%.0f%%", pct))))
	default:
		b.WriteString(fmt.Sprintf("  [3/3] Generating embeddings %s %d/%d %s\n",
			dimStyle.Render("···"), m.embedTot, m.embedTot, doneStyle.Render("✓")))
	}

	// Footer.
	b.WriteString("\n")
	if m.phase == harvestComplete {
		total := m.result.Applied + m.result.Unchanged
		b.WriteString(fmt.Sprintf("  %s (%s)\n",
			doneStyle.Render("✓ Harvest complete"), elapsed))
		b.WriteString(fmt.Sprintf("  %d docs (%d updated, %d unchanged), %d embeddings\n\n",
			total, m.result.Applied, m.result.Unchanged, m.result.Embedded))
	} else if m.phase == harvestError {
		b.WriteString(fmt.Sprintf("  %s %v\n\n",
			errStyle.Render("✗ Error:"), m.err))
	} else {
		b.WriteString(fmt.Sprintf("  %s\n",
			dimStyle.Render(fmt.Sprintf("%s elapsed", elapsed))))
	}

	return tea.NewView(b.String())
}

func runHarvest() error {
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

	m := newHarvestModel()
	m.cancel = cancel
	p := tea.NewProgram(m)

	go func() {
		// Phase 1: Crawl.
		sf, crawlErr := install.Crawl(&install.CrawlProgress{
			OnDocsPage: func(done, total int) {
				p.Send(crawlDocsMsg{done, total})
			},
			OnBlogPost: func(done, total int) {
				p.Send(crawlBlogMsg{done, total})
			},
			OnCustomSource: func(name string, done, total int) {
				p.Send(crawlCustomMsg{name, done, total})
			},
			OnCustomPage: func(done, total int) {
				p.Send(crawlCustomMsg{"", done, total})
			},
		})
		p.Send(crawlDoneMsg{sf, crawlErr})
		if sf == nil {
			return
		}

		// Phase 2+3: Seed + Embed.
		prog := &install.SeedProgress{
			OnDocUpsert: func(done, total int) {
				p.Send(harvestDocMsg{done, total})
			},
			OnEmbedBatch: func(done, total int) {
				p.Send(harvestEmbedMsg{done, total})
			},
		}
		result, err := install.ApplySeedData(ctx, st, emb, sf, prog)
		p.Send(harvestDoneMsg{result, err})
	}()

	_, err = p.Run()
	return err
}
