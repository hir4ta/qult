package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mark3labs/mcp-go/server"
	"github.com/hir4ta/claude-alfred/internal/analyzer"
	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/hookhandler"
	"github.com/hir4ta/claude-alfred/internal/install"
	"github.com/hir4ta/claude-alfred/internal/mcpserver"
	"github.com/hir4ta/claude-alfred/internal/store"
	"github.com/hir4ta/claude-alfred/internal/tui"
	"github.com/hir4ta/claude-alfred/internal/watcher"
)

// version is set at build time via ldflags (-X main.version=...).
var version = "dev"

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cmd := "watch"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}

	switch cmd {
	case "watch":
		return runWatch()
	case "browse":
		return runBrowse()
	case "serve":
		return runServe()
	case "install":
		return install.Run(os.Args[2:])
	case "count-sessions":
		return install.CountSessions()
	case "uninstall":
		return install.Uninstall()
	case "analyze":
		return runAnalyze()
	case "crawl-seed":
		output := "internal/install/seed_docs.json"
		if len(os.Args) > 2 {
			output = os.Args[2]
		}
		return install.CrawlSeed(output)
	case "plugin-bundle":
		outputDir := "./plugin"
		if len(os.Args) > 2 {
			outputDir = os.Args[2]
		}
		return install.Bundle(outputDir, version)
	case "hook-handler":
		if len(os.Args) < 3 {
			return fmt.Errorf("usage: claude-alfred hook-handler <EventName>")
		}
		return hookhandler.Run(os.Args[2])
	case "version", "--version", "-v":
		fmt.Printf("claude-alfred %s\n", version)
		return nil
	case "help", "-h", "--help":
		printUsage()
		return nil
	default:
		printUsage()
		return fmt.Errorf("unknown command: %s", cmd)
	}
}

func runWatch() error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		cancel()
		os.Exit(0)
	}()

	claudeHome := watcher.DefaultClaudeHome()

	sessions, err := watcher.FindRecentSessions(claudeHome, 10)
	if err != nil || len(sessions) == 0 {
		return fmt.Errorf("no sessions found")
	}

	// Interactive session selector
	selectModel := tui.NewSelectModel(sessions)
	selectProg := tea.NewProgram(selectModel, tea.WithAltScreen())
	finalModel, err := selectProg.Run()
	if err != nil {
		return fmt.Errorf("session selector error: %w", err)
	}
	sm := finalModel.(tui.SelectModel)
	choice := sm.Selected()
	if choice < 0 {
		return nil // user cancelled
	}

	selected := sessions[choice]
	result, err := watcher.Watch(ctx, selected.Path, false)
	if err != nil {
		return fmt.Errorf("failed to watch session: %w", err)
	}

	sid := selected.SessionID
	if len(sid) > 8 {
		sid = sid[:8]
	}
	fmt.Printf("Watching session: %s (%d existing events)\n", sid, len(result.InitialEvents))

	// Open store for dashboard tabs (nil-safe if unavailable).
	st, _ := store.OpenDefaultCached()

	model := tui.NewModel(result.InitialEvents, result.EventCh, selected.SessionID, st)
	p := tea.NewProgram(model, tea.WithAltScreen())

	if _, err := p.Run(); err != nil {
		return fmt.Errorf("TUI error: %w", err)
	}

	return nil
}

func runBrowse() error {
	claudeHome := watcher.DefaultClaudeHome()

	sessions, err := watcher.ListSessions(claudeHome)
	if err != nil {
		return fmt.Errorf("failed to list sessions: %w", err)
	}

	model := tui.NewBrowseModel(sessions)
	p := tea.NewProgram(model, tea.WithAltScreen())

	if _, err := p.Run(); err != nil {
		return fmt.Errorf("TUI error: %w", err)
	}

	return nil
}

func runServe() error {
	claudeHome := watcher.DefaultClaudeHome()

	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("failed to open store: %w", err)
	}
	defer st.Close()

	// Try to initialize embedder (graceful degradation if VOYAGE_API_KEY not set).
	emb := embedder.NewEmbedder()
	ctx := context.Background()
	emb.EnsureAvailable(ctx)

	s := mcpserver.New(claudeHome, st, emb)
	return server.ServeStdio(s)
}

func runAnalyze() error {
	claudeHome := watcher.DefaultClaudeHome()

	sessions, err := watcher.ListSessions(claudeHome)
	if err != nil || len(sessions) == 0 {
		return fmt.Errorf("no sessions found")
	}

	var target watcher.SessionInfo
	if len(os.Args) > 2 {
		prefix := os.Args[2]
		for _, s := range sessions {
			if strings.HasPrefix(s.SessionID, prefix) {
				target = s
				break
			}
		}
		if target.Path == "" {
			return fmt.Errorf("session not found: %s", prefix)
		}
	} else {
		target = sessions[0]
	}

	detail, err := watcher.LoadSessionDetail(target)
	if err != nil {
		return fmt.Errorf("load session: %w", err)
	}

	stats := analyzer.NewStats()
	det := analyzer.NewDetector()
	for _, ev := range detail.Events {
		stats.Update(ev)
		det.Update(ev)
	}

	sid := target.SessionID
	if len(sid) > 8 {
		sid = sid[:8]
	}

	features := mcpserver.TrackFeatures(detail.Events)
	hints := mcpserver.ComputeUsageHints(detail.Events, stats)
	recs := mcpserver.BuildRecommendations(hints, features, det.ActiveAlerts())

	fmt.Print(mcpserver.FormatAnalyzeReport(sid, stats, det, features, hints, recs))
	return nil
}

func printUsage() {
	fmt.Println(`claude-alfred - Claude Code companion TUI

Usage:
  claude-alfred [command]

Commands:
  watch         Monitor active Claude Code session in real-time (default)
  browse        Browse past session history
  serve         Run as MCP server (stdio) for Claude Code integration
  hook-handler  Handle Claude Code hook events (stdin/stdout JSON)
  install       Sync sessions and generate embeddings (--since=7d|14d|30d|90d)
  count-sessions Show session counts per sync range (JSON)
  uninstall     Remove hooks and MCP server registration
  analyze       Session analysis report
  crawl-seed    Crawl official docs and generate seed_docs.json
  plugin-bundle Generate plugin directory from Go sources
  version       Show version
  help          Show this help

Options:
  VOYAGE_API_KEY  Enable vector search for pattern matching`)
}
