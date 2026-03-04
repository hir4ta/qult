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
	phase        harvestPhase
	singleSource bool // true when harvesting a single custom source
	startTime    time.Time
	err          error
	result       install.SeedResult

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

	steps := 3
	if m.singleSource {
		steps = 2
	}

	if m.singleSource {
		// Single-source mode: only custom crawling.
		m.viewCrawlSingle(&b, steps)
	} else {
		// Full mode: docs + blog + custom.
		m.viewCrawlFull(&b, steps)
	}

	// Seeding docs (full harvest only — single-source skips this display).
	if !m.singleSource {
		switch {
		case m.phase < harvestSeeding:
			// not started
		case m.phase == harvestSeeding:
			fmt.Fprintf(&b, "  [2/%d] Seeding docs %s %d/%d\n",
				steps, dimStyle.Render("···"), m.docsDone, m.docsTotal)
		default:
			fmt.Fprintf(&b, "  [2/%d] Seeding docs %s %d/%d %s\n",
				steps, dimStyle.Render("···"), m.docsTotal, m.docsTotal, doneStyle.Render("✓"))
		}
	}

	// Embedding.
	embedStep := steps
	switch {
	case m.phase < harvestEmbedding:
		// not started
	case m.phase == harvestEmbedding:
		var pct float64
		if m.embedTot > 0 {
			pct = float64(m.embedDone) / float64(m.embedTot) * 100
		}
		fmt.Fprintf(&b, "  [%d/%d] Generating embeddings %s %d/%d\n",
			embedStep, steps, dimStyle.Render("···"), m.embedDone, m.embedTot)
		fmt.Fprintf(&b, "        %s %s\n",
			m.progress.View(), dimStyle.Render(fmt.Sprintf("%.0f%%", pct)))
	default:
		fmt.Fprintf(&b, "  [%d/%d] Generating embeddings %s %d/%d %s\n",
			embedStep, steps, dimStyle.Render("···"), m.embedTot, m.embedTot, doneStyle.Render("✓"))
	}

	// Footer.
	b.WriteString("\n")
	if m.phase == harvestComplete {
		total := m.result.Applied + m.result.Unchanged
		fmt.Fprintf(&b, "  %s (%s)\n", doneStyle.Render("✓ Harvest complete"), elapsed)
		fmt.Fprintf(&b, "  %d docs (%d updated, %d unchanged), %d embeddings\n\n",
			total, m.result.Applied, m.result.Unchanged, m.result.Embedded)
	} else if m.phase == harvestError {
		fmt.Fprintf(&b, "  %s %v\n\n", errStyle.Render("✗ Error:"), m.err)
	} else {
		fmt.Fprintf(&b, "  %s\n", dimStyle.Render(fmt.Sprintf("%s elapsed", elapsed)))
	}

	return tea.NewView(b.String())
}

func (m harvestModel) viewCrawlFull(b *strings.Builder, steps int) {
	switch {
	case m.phase == harvestCrawling:
		if m.customTotal > 0 {
			fmt.Fprintf(b, "  [1/%d] Crawling docs %s %d/%d %s\n",
				steps, dimStyle.Render("···"), m.crawlDocsDone, m.crawlDocsDone, doneStyle.Render("✓"))
			if m.crawlBlogTotal > 0 {
				fmt.Fprintf(b, "        Crawling blog %s %d/%d %s\n",
					dimStyle.Render("···"), m.crawlBlogTotal, m.crawlBlogTotal, doneStyle.Render("✓"))
			}
			fmt.Fprintf(b, "        Crawling %s %s %d/%d\n",
				m.customName, m.spinner.View(), m.customDone, m.customTotal)
		} else if m.crawlDocsTotal > 0 {
			fmt.Fprintf(b, "  [1/%d] Crawling docs %s %d/%d\n",
				steps, m.spinner.View(), m.crawlDocsDone, m.crawlDocsTotal)
			if m.crawlBlogTotal > 0 {
				fmt.Fprintf(b, "        Crawling blog %s %d/%d\n",
					dimStyle.Render("···"), m.crawlBlogDone, m.crawlBlogTotal)
			}
		} else {
			fmt.Fprintf(b, "  [1/%d] Crawling docs %s\n", steps, m.spinner.View())
		}
	default:
		total := m.crawlDocsTotal + m.crawlBlogTotal + m.customTotal
		if m.customTotal > 0 {
			fmt.Fprintf(b, "  [1/%d] Crawling %s %d pages (%d docs, %d blog, %d custom) %s\n",
				steps, dimStyle.Render("···"), total, m.crawlDocsTotal, m.crawlBlogTotal, m.customTotal, doneStyle.Render("✓"))
		} else {
			fmt.Fprintf(b, "  [1/%d] Crawling %s %d pages %s\n",
				steps, dimStyle.Render("···"), total, doneStyle.Render("✓"))
		}
	}
}

func (m harvestModel) viewCrawlSingle(b *strings.Builder, steps int) {
	switch {
	case m.phase == harvestCrawling:
		if m.customTotal > 0 {
			fmt.Fprintf(b, "  [1/%d] Crawling %s %s %d/%d\n",
				steps, m.customName, m.spinner.View(), m.customDone, m.customTotal)
		} else {
			fmt.Fprintf(b, "  [1/%d] Crawling %s\n", steps, m.spinner.View())
		}
	default:
		fmt.Fprintf(b, "  [1/%d] Crawling %s %d pages %s\n",
			steps, dimStyle.Render("···"), m.customTotal, doneStyle.Render("✓"))
	}
}

func runHarvest(sourceName string) error {
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
	m.singleSource = sourceName != ""
	p := tea.NewProgram(m)

	go func() {
		var sf *install.SeedFile

		if sourceName != "" {
			// Single-source mode: crawl + embed only the named source.
			var crawlErr error
			sf, crawlErr = crawlSingleSource(sourceName, p)
			if crawlErr != nil {
				p.Send(crawlDoneMsg{nil, crawlErr})
				return
			}
			p.Send(crawlDoneMsg{sf, nil})
		} else {
			// Full harvest mode.
			var crawlErr error
			sf, crawlErr = install.Crawl(&install.CrawlProgress{
				OnDocsPage: func(done, total int) {
					p.Send(crawlDocsMsg{done, total})
				},
				OnBlogPost: func(done, total int) {
					p.Send(crawlBlogMsg{done, total})
				},
				OnCustomSource: func(name string, done, total int) {
					p.Send(crawlCustomMsg{name, done, total})
				},
				OnCustomPage: func(name string, done, total int) {
					p.Send(crawlCustomMsg{name, done, total})
				},
			})
			p.Send(crawlDoneMsg{sf, crawlErr})
		}
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
		result, seedErr := install.ApplySeedData(ctx, st, emb, sf, prog)
		p.Send(harvestDoneMsg{result, seedErr})
	}()

	_, err = p.Run()
	return err
}

func crawlSingleSource(name string, p *tea.Program) (*install.SeedFile, error) {
	csf, err := install.ParseSourcesFile(install.DefaultSourcesPath())
	if err != nil {
		return nil, err
	}
	if csf == nil {
		return nil, fmt.Errorf("sources.yaml not found")
	}
	var target []install.CustomSource
	for _, src := range csf.Sources {
		if src.Name == name {
			target = append(target, src)
		}
	}
	if len(target) == 0 {
		return nil, fmt.Errorf("source %q not found in sources.yaml", name)
	}

	sources := install.CrawlCustomSources(target, &install.CrawlCustomProgress{
		OnPage: func(name string, done, total int) {
			p.Send(crawlCustomMsg{name, done, total})
		},
	})

	return &install.SeedFile{
		CrawledAt: time.Now().UTC().Format(time.RFC3339),
		Sources:   sources,
	}, nil
}
