package main

import (
	"fmt"
	"os"
	"runtime/debug"
	"slices"
	"strings"

	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/install"
	"github.com/hir4ta/claude-alfred/internal/mcpserver"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// Build info set at build time via ldflags.
var (
	version = "dev"
	commit  = "unknown"
	date    = "unknown"
)

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
	case "init":
		return runSetup()
	case "setup":
		// Legacy alias for "init".
		return runSetup()
	case "update":
		return runUpdate()
	case "status":
		return runStatus()
	case "export":
		return runExport()
	case "memory":
		return runMemory()
	case "settings":
		return runSettings()
	case "analytics":
		return runAnalytics()
	case "doctor":
		return runDoctor()
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
	case "crawl-async":
		return runCrawlAsync()
	case "embed-async":
		return runEmbedAsync()
	case "embed-doc":
		return runEmbedDoc()
	case "hook":
		if len(os.Args) < 3 {
			return fmt.Errorf("usage: alfred hook <EventName>")
		}
		return runHookWithGuard(os.Args[2])
	case "version", "--version", "-v":
		// --short flag for machine-readable version (used by run.sh).
		if slices.Contains(os.Args[1:], "--short") {
			fmt.Println(resolvedVersion())
			return nil
		}
		showVersion()
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

// runHookWithGuard adds a TTY guard so users don't accidentally run hook commands.
func runHookWithGuard(event string) error {
	if stdinIsTTY() {
		fmt.Fprintln(os.Stderr, "This command is called by Claude Code hooks and is not meant to be run manually.")
		fmt.Fprintln(os.Stderr, "Hooks are configured automatically when you install the plugin.")
		return nil
	}
	return runHook(event)
}

// stdinIsTTY reports whether stdin is a terminal (not a pipe or redirect).
func stdinIsTTY() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

func runServe() error {
	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("failed to open store: %w", err)
	}
	defer st.Close()

	// Embedder is optional — graceful degradation to FTS-only search.
	var emb *embedder.Embedder
	if e, err := embedder.NewEmbedder(); err != nil {
		fmt.Fprintln(os.Stderr, "Warning: VOYAGE_API_KEY not set — running in FTS-only mode (no vector search or reranking). Run 'alfred settings' to configure.")
	} else {
		emb = e
		// Set expected dimensions so InsertEmbedding validates vector sizes.
		st.ExpectedDims = e.Dims()
	}

	if count, _ := st.SeedDocsCount(); count == 0 {
		fmt.Fprintln(os.Stderr, "Warning: no seed docs found. Run 'alfred init' to initialize.")
	}

	s := mcpserver.New(st, emb, resolvedVersion())
	return server.ServeStdio(s)
}

// resolvedVersion returns the best available version string.
// Priority: ldflags > module version (go install) > "dev".
func resolvedVersion() string {
	if version != "dev" {
		return version
	}
	if bi, ok := debug.ReadBuildInfo(); ok && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
		return strings.TrimPrefix(bi.Main.Version, "v")
	}
	return version
}

// resolvedCommit returns the best available commit hash.
func resolvedCommit() string {
	if commit != "unknown" {
		return commit
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, s := range bi.Settings {
			if s.Key == "vcs.revision" {
				if len(s.Value) > 7 {
					return s.Value[:7]
				}
				return s.Value
			}
		}
	}
	return ""
}

// resolvedDate returns the best available build date.
func resolvedDate() string {
	if date != "unknown" {
		return date
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, s := range bi.Settings {
			if s.Key == "vcs.time" {
				return s.Value
			}
		}
	}
	return ""
}

func printUsage() {
	fmt.Println(`alfred - Your silent butler for Claude Code

Usage:
  alfred [command]

Commands:
  init           Initialize knowledge base (seed docs + generate embeddings)
  status         Show system status (DB, API keys, active tasks)
  export         Export memories to JSON (--all includes specs)
  memory         Manage memories (prune, stats)
  settings       Configure API keys and preferences
  analytics      Show feedback loop stats and injection activity
  doctor         Diagnose common issues (DB, hooks, API keys)
  update         Update alfred to the latest version
  version        Show version
  help           Show this help

Environment:
  VOYAGE_API_KEY     Optional (FTS-only fallback without it). Enables semantic vector search
                     and Voyage AI reranking. Run 'alfred settings' to configure interactively.`)
}
