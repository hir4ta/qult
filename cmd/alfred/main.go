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
	case "dashboard", "dash":
		return runDashboard()
	case "serve":
		return runServe()
	case "plugin-bundle":
		outputDir := "./plugin"
		if len(os.Args) > 2 {
			outputDir = os.Args[2]
		}
		return install.Bundle(outputDir, version)
	case "export":
		return runExport()
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

	// Embedder is optional — graceful degradation to keyword-only search.
	var emb *embedder.Embedder
	if e, err := embedder.NewEmbedder(); err != nil {
		fmt.Fprintln(os.Stderr, "Warning: VOYAGE_API_KEY not set — running in keyword-only mode (no vector search or reranking).")
	} else {
		emb = e
		// Set expected dimensions so searches validate compatibility.
		st.ExpectedDims = e.Dims()
	}

	s := mcpserver.New(st, emb, resolvedVersion())
	err = server.ServeStdio(s)
	mcpserver.WaitBackground()
	return err
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

func showVersion() {
	fmt.Printf("alfred %s", resolvedVersion())
	if c := resolvedCommit(); c != "" {
		fmt.Printf(" (%s)", c)
	}
	if d := resolvedDate(); d != "" {
		fmt.Printf(" built %s", d)
	}
	fmt.Println()
}

func printUsage() {
	fmt.Println(`alfred - Your silent butler for Claude Code

Usage:
  alfred dashboard  Open TUI dashboard (alias: dash)
  alfred serve      Start MCP server (called by Claude Code plugin)
  alfred hook       Handle hook events (called by Claude Code)
  alfred export     Export memories to .alfred/knowledge/ (Git-shareable YAML)
  alfred version    Show version

Environment:
  VOYAGE_API_KEY     Enables semantic vector search and reranking.
                     Without it, keyword-based (LIKE) search is used.`)
}
