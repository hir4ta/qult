package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mark3labs/mcp-go/server"
	"github.com/hir4ta/claude-alfred/internal/embedder"
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
	case "hook":
		if len(os.Args) < 3 {
			return fmt.Errorf("usage: claude-alfred hook <EventName>")
		}
		return runHook(os.Args[2])
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

	// Open store (nil-safe if unavailable).
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

	emb, err := embedder.NewEmbedder()
	if err != nil {
		return fmt.Errorf("embedder: %w (set VOYAGE_API_KEY)", err)
	}

	s := mcpserver.New(claudeHome, st, emb)
	return server.ServeStdio(s)
}

func runAnalyze() error {
	fmt.Println("analyze command is being redesigned. Use /alfred:review via MCP instead.")
	return nil
}

// hookEvent is the minimal structure of a Claude Code hook stdin payload.
type hookEvent struct {
	SessionID   string `json:"session_id"`
	ProjectPath string `json:"cwd"`
	ToolName    string `json:"tool_name"`
	ToolError   bool   `json:"tool_error"`
}

// runHook handles silent hook events. Reads stdin, records to store, produces no output.
func runHook(event string) error {
	var ev hookEvent
	if err := json.NewDecoder(os.Stdin).Decode(&ev); err != nil {
		// Malformed input — silently ignore (butler never complains).
		return nil
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		return nil // store unavailable — silently skip
	}

	switch event {
	case "SessionStart":
		if ev.SessionID != "" && ev.ProjectPath != "" {
			_ = st.EnsureSession(ev.SessionID, ev.ProjectPath)
		}
	case "PostToolUse":
		if ev.SessionID != "" && ev.ToolName != "" {
			_ = st.RecordToolUse(ev.SessionID, ev.ToolName, !ev.ToolError)
		}
	case "SessionEnd":
		// Session statistics are already maintained incrementally.
		// Nothing extra to do — the store is consistent.
	}

	return nil
}

func printUsage() {
	fmt.Println(`alfred - Your silent butler for Claude Code

Usage:
  claude-alfred [command]

Commands:
  watch          Monitor active Claude Code session in real-time (default)
  browse         Browse past session history
  serve          Run as MCP server (stdio) for Claude Code integration
  hook           Handle silent hook events (no output)
  install        Sync sessions and generate embeddings (--since=7d|14d|30d|90d)
  count-sessions Show session counts per sync range (JSON)
  uninstall      Remove MCP server registration
  analyze        Project analysis report
  crawl-seed     Crawl official docs and generate seed_docs.json
  plugin-bundle  Generate plugin directory from Go sources
  version        Show version
  help           Show this help

Requirements:
  VOYAGE_API_KEY  Required for vector search (serve/install commands)`)
}
