package main

import (
	"fmt"
	"os"

	"github.com/mark3labs/mcp-go/server"
	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/install"
	"github.com/hir4ta/claude-alfred/internal/mcpserver"
	"github.com/hir4ta/claude-alfred/internal/store"
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
	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}

	switch cmd {
	case "serve":
		return runServe()
	case "install":
		return install.Run(os.Args[2:])
	case "uninstall":
		return install.Uninstall()
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
			return fmt.Errorf("usage: alfred hook <EventName>")
		}
		return runHook(os.Args[2])
	case "version", "--version", "-v":
		fmt.Printf("alfred %s\n", version)
		return nil
	case "help", "-h", "--help":
		printUsage()
		return nil
	default:
		printUsage()
		if cmd == "" {
			return nil
		}
		return fmt.Errorf("unknown command: %s", cmd)
	}
}

func runServe() error {
	claudeHome := watcher.DefaultClaudeHome()

	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("failed to open store: %w", err)
	}
	defer st.Close()

	emb, _ := embedder.NewEmbedder() // nil when VOYAGE_API_KEY is unset; graceful FTS5-only fallback

	s := mcpserver.New(claudeHome, st, emb)
	return server.ServeStdio(s)
}

func printUsage() {
	fmt.Println(`alfred - Your silent butler for Claude Code

Usage:
  alfred [command]

Commands:
  serve          Run as MCP server (stdio) for Claude Code integration
  hook           Handle silent hook events (no output)
  install        Set up alfred (skills, hooks, MCP, rules, DB sync)
  uninstall      Remove alfred completely (hooks, MCP, skills, rules, DB, binary)
  crawl-seed     Crawl official docs and generate seed_docs.json
  plugin-bundle  Generate plugin directory from Go sources
  version        Show version
  help           Show this help

Environment:
  VOYAGE_API_KEY     Optional. Enables semantic vector search (hybrid RRF + reranking).
                     Without it, search falls back to FTS5-only.`)
}
