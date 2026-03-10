package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// memoryByProject holds per-project memory counts for verbose display.
type memoryByProject struct {
	project string
	count   int
}

// statusInfo gathers all system state for the status display.
type statusInfo struct {
	version   string
	commit    string
	date      string
	dbPath    string
	dbExists  bool
	dbSizeMB  float64
	docsCount int
	memCount  int64
	specCount int64
	embedCount int
	hasVoyage bool
	voyageModel string
	activeTask string
	specDir    string
	lastCrawl  string
	memByProject []memoryByProject // verbose only
}

func gatherStatus(verbose bool) statusInfo {
	info := statusInfo{
		version: resolvedVersion(),
		commit:  resolvedCommit(),
		date:    resolvedDate(),
		dbPath:  store.DefaultDBPath(),
	}

	// Check Voyage API key.
	if e, err := embedder.NewEmbedder(); err == nil {
		info.hasVoyage = true
		info.voyageModel = e.Model()
	}

	// Check DB existence and size.
	if fi, err := os.Stat(info.dbPath); err == nil {
		info.dbExists = true
		info.dbSizeMB = float64(fi.Size()) / (1024 * 1024)
	}

	// Open store for stats.
	if !info.dbExists {
		return info
	}
	st, err := store.OpenDefault()
	if err != nil {
		return info
	}
	defer st.Close()

	ctx := context.Background()

	info.docsCount, _ = st.SeedDocsCount()
	info.memCount, _ = st.CountDocsByURLPrefix(ctx, "memory://")
	info.specCount, _ = st.CountDocsByURLPrefix(ctx, "spec://")

	info.embedCount, _ = st.CountEmbeddings()

	// Last crawl time.
	if t, err := st.LastCrawledAt(); err == nil {
		info.lastCrawl = t.Format("2006-01-02 15:04")
	}

	// Active spec task.
	home, _ := os.UserHomeDir()
	cwd, _ := os.Getwd()
	projectPath := cwd
	if projectPath == "" {
		projectPath = home
	}
	if slug, err := spec.ReadActive(projectPath); err == nil && slug != "" {
		info.activeTask = slug
		sd := spec.SpecDir{ProjectPath: projectPath, TaskSlug: slug}
		info.specDir = sd.Dir()
	}

	// Verbose: memory breakdown by project.
	if verbose {
		if stats, err := st.MemoryStatsByProject(ctx, 10); err == nil {
			for _, s := range stats {
				info.memByProject = append(info.memByProject, memoryByProject{s.Project, s.Count})
			}
		}
	}

	return info
}

func runStatus() error {
	verbose := slices.Contains(os.Args[1:], "--verbose")
	info := gatherStatus(verbose)

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7571F9"))
	labelWidth := 20
	if verbose {
		labelWidth = 36
	}
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#626262")).Width(labelWidth)
	valStyle := lipgloss.NewStyle().Bold(true)
	okStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#04B575"))
	warnStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#FF4672"))
	mutedStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#626262"))

	var b strings.Builder

	// Header.
	b.WriteString("\n")
	b.WriteString("  " + headerStyle.Render("⚡ alfred status") + "\n")
	b.WriteString("  " + mutedStyle.Render(strings.Repeat("─", 42)) + "\n\n")

	// Version.
	verLine := valStyle.Render(info.version)
	if info.commit != "" {
		verLine += " " + mutedStyle.Render("("+info.commit+")")
	}
	b.WriteString("  " + labelStyle.Render("Version") + verLine + "\n")

	// Voyage API.
	if info.hasVoyage {
		b.WriteString("  " + labelStyle.Render("Voyage API") + okStyle.Render("✓ connected") +
			" " + mutedStyle.Render(info.voyageModel) + "\n")
	} else {
		b.WriteString("  " + labelStyle.Render("Voyage API") + warnStyle.Render("✗ not set") +
			" " + mutedStyle.Render("(FTS-only mode)") + "\n")
	}

	// DB.
	b.WriteString("\n")
	if info.dbExists {
		b.WriteString("  " + labelStyle.Render("Database") + okStyle.Render("✓ ") +
			mutedStyle.Render(fmt.Sprintf("%.1f MB", info.dbSizeMB)) + "\n")
		b.WriteString("  " + labelStyle.Render("  Knowledge docs") + valStyle.Render(fmt.Sprintf("%d", info.docsCount)) + "\n")
		b.WriteString("  " + labelStyle.Render("  Embeddings") + valStyle.Render(fmt.Sprintf("%d", info.embedCount)) + "\n")
		b.WriteString("  " + labelStyle.Render("  Memories") + valStyle.Render(fmt.Sprintf("%d", info.memCount)) + "\n")
		b.WriteString("  " + labelStyle.Render("  Spec docs") + valStyle.Render(fmt.Sprintf("%d", info.specCount)) + "\n")
		if info.lastCrawl != "" {
			b.WriteString("  " + labelStyle.Render("  Last crawl") + mutedStyle.Render(info.lastCrawl) + "\n")
		}
	} else {
		b.WriteString("  " + labelStyle.Render("Database") + warnStyle.Render("✗ not initialized") + "\n")
		b.WriteString("  " + mutedStyle.Render("  Run 'alfred init' to set up the knowledge base") + "\n")
	}

	// Active spec.
	b.WriteString("\n")
	if info.activeTask != "" {
		b.WriteString("  " + labelStyle.Render("Active task") + valStyle.Render(info.activeTask) + "\n")
		home, _ := os.UserHomeDir()
		displayPath := info.specDir
		if home != "" {
			displayPath = strings.Replace(displayPath, home, "~", 1)
		}
		b.WriteString("  " + labelStyle.Render("  Spec dir") + mutedStyle.Render(displayPath) + "\n")
	} else {
		b.WriteString("  " + labelStyle.Render("Active task") + mutedStyle.Render("none") + "\n")
	}

	// Paths.
	b.WriteString("\n")
	home, _ := os.UserHomeDir()
	dbDisplay := info.dbPath
	if home != "" {
		dbDisplay = strings.Replace(dbDisplay, home, "~", 1)
	}
	b.WriteString("  " + labelStyle.Render("DB path") + mutedStyle.Render(dbDisplay) + "\n")

	pluginRoot := findInstalledPluginRoot()
	if pluginRoot != "" {
		if home != "" {
			pluginRoot = strings.Replace(pluginRoot, home, "~", 1)
		}
		b.WriteString("  " + labelStyle.Render("Plugin root") + mutedStyle.Render(pluginRoot) + "\n")
	}

	configDir := filepath.Join(home, ".claude-alfred")
	configDisplay := strings.Replace(configDir, home, "~", 1)
	b.WriteString("  " + labelStyle.Render("Config dir") + mutedStyle.Render(configDisplay) + "\n")

	// Verbose: environment overrides and operational details.
	if verbose && info.dbExists {
		b.WriteString("\n")
		b.WriteString("  " + headerStyle.Render("Environment") + "\n")
		b.WriteString("  " + mutedStyle.Render(strings.Repeat("─", 42)) + "\n\n")

		envVars := []struct {
			name, fallback string
		}{
			{"ALFRED_QUIET", "0"},
			{"ALFRED_RELEVANCE_THRESHOLD", "0.40"},
			{"ALFRED_HIGH_CONFIDENCE_THRESHOLD", "0.65"},
			{"ALFRED_SINGLE_KEYWORD_DAMPEN", "0.80"},
			{"ALFRED_CRAWL_INTERVAL_DAYS", "7"},
			{"ALFRED_DEBUG", ""},
		}
		for _, ev := range envVars {
			val := os.Getenv(ev.name)
			if val == "" {
				if ev.fallback != "" {
					b.WriteString("  " + labelStyle.Render("  "+ev.name) + mutedStyle.Render(ev.fallback+" (default)") + "\n")
				}
			} else {
				b.WriteString("  " + labelStyle.Render("  "+ev.name) + valStyle.Render(val) + "\n")
			}
		}

		// Memory breakdown by project (data gathered in gatherStatus).
		if len(info.memByProject) > 0 {
			b.WriteString("\n  " + headerStyle.Render("Memories by project") + "\n")
			b.WriteString("  " + mutedStyle.Render(strings.Repeat("─", 42)) + "\n\n")
			for _, mp := range info.memByProject {
				b.WriteString("  " + labelStyle.Render("  "+mp.project) + valStyle.Render(fmt.Sprintf("%d", mp.count)) + "\n")
			}
		}
	}

	if !verbose {
		b.WriteString("  " + mutedStyle.Render("Run 'alfred status --verbose' for environment details") + "\n")
	}
	b.WriteString("\n")
	fmt.Print(b.String())
	return nil
}
