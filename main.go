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
	"github.com/hir4ta/claude-buddy/internal/coach"
	"github.com/hir4ta/claude-buddy/internal/install"
	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/mcpserver"
	"github.com/hir4ta/claude-buddy/internal/store"
	"github.com/hir4ta/claude-buddy/internal/tui"
	"github.com/hir4ta/claude-buddy/internal/watcher"
)

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
		return install.Run()
	case "analyze":
		return runAnalyze()
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

	lang := locale.Detect()

	sessions, err := watcher.FindRecentSessions(claudeHome, 10)
	if err != nil || len(sessions) == 0 {
		return fmt.Errorf("no sessions found")
	}

	// Interactive session selector
	selectModel := tui.NewSelectModel(sessions, lang)
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

	model := tui.NewModel(result.InitialEvents, result.EventCh, selected.SessionID, lang)
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
	lang := locale.Detect()

	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("failed to open store: %w", err)
	}
	defer st.Close()

	s := mcpserver.New(claudeHome, lang, st)
	return server.ServeStdio(s)
}

func runAnalyze() error {
	claudeHome := watcher.DefaultClaudeHome()

	sessions, err := watcher.ListSessions(claudeHome)
	if err != nil || len(sessions) == 0 {
		return fmt.Errorf("no sessions found")
	}

	// Optional: analyze specific session by ID prefix
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

	fmt.Printf("Analyzing session %s (%s)...\n", target.SessionID[:8], target.Project)

	report, err := coach.BuildReport(target)
	if err != nil {
		return fmt.Errorf("build report: %w", err)
	}

	fmt.Printf("Turns: %d | Tools: %d | %dmin\n", report.TurnCount, report.ToolUseCount, report.DurationMin)
	fmt.Println()

	fmt.Println("Running AI analysis via claude -p ...")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		cancel()
		os.Exit(0)
	}()

	lang := locale.Detect()
	analysis, err := coach.Analyze(ctx, report, lang)
	if err != nil {
		return fmt.Errorf("AI analysis failed: %w\nMake sure 'claude' CLI is installed and available in PATH", err)
	}

	fmt.Println()
	fmt.Println(analysis)

	return nil
}

func printUsage() {
	fmt.Println(`claude-buddy - Claude Code companion TUI

Usage:
  claude-buddy [command]

Commands:
  watch      Monitor active Claude Code session in real-time (default)
  browse     Browse past session history
  serve      Run as MCP server (stdio) for Claude Code integration
  install    Register MCP server, update CLAUDE.md, and sync sessions
  analyze    AI-powered session analysis via claude -p (no extra cost)
  help       Show this help

Language:
  AI feedback is generated in your system language (detected from LANG).
  To override: LANG=ja_JP.UTF-8 claude-buddy`)
}
