package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"charm.land/lipgloss/v2"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/spec"
	"github.com/hir4ta/claude-alfred/internal/store"
)

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
}

func gatherStatus() statusInfo {
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
	var crawledAt string
	_ = st.DB().QueryRow(
		`SELECT crawled_at FROM docs WHERE source_type = 'docs' ORDER BY crawled_at DESC LIMIT 1`,
	).Scan(&crawledAt)
	if crawledAt != "" {
		if t, err := time.Parse(time.RFC3339, crawledAt); err == nil {
			info.lastCrawl = t.Format("2006-01-02 15:04")
		} else {
			info.lastCrawl = crawledAt
		}
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

	return info
}

func runStatus() error {
	info := gatherStatus()

	headerStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7571F9"))
	labelStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("#626262")).Width(20)
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

	b.WriteString("\n")
	fmt.Print(b.String())
	return nil
}
