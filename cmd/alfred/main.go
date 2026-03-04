package main

import (
	"fmt"
	"os"
	"runtime/debug"
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
	case "setup":
		return runSetup()
	case "harvest":
		sourceName := ""
		for i, arg := range os.Args[2:] {
			if arg == "--source" && i+1 < len(os.Args[2:]) {
				sourceName = os.Args[2+i+1]
			}
		}
		return runHarvest(sourceName)
	case "update":
		return runUpdate()
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

func runServe() error {
	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("failed to open store: %w", err)
	}
	defer st.Close()

	emb, err := embedder.NewEmbedder()
	if err != nil {
		return fmt.Errorf("VOYAGE_API_KEY is required: %w", err)
	}

	if count, _ := st.SeedDocsCount(); count == 0 {
		fmt.Fprintln(os.Stderr, "Warning: no seed docs found. Run 'alfred setup' to initialize.")
	}

	s := mcpserver.New(st, emb)
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
  serve          Run as MCP server (stdio) for Claude Code integration
  setup          Initialize knowledge base (seed docs + generate embeddings)
  harvest        Refresh knowledge base (crawl + embed fresh docs)
  update         Update alfred to the latest version
  version        Show version
  help           Show this help

Environment:
  VOYAGE_API_KEY     Required. Enables semantic vector search with Voyage AI.`)
}
