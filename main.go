package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
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

	emb, _ := embedder.NewEmbedder() // nil when VOYAGE_API_KEY is unset; graceful FTS5-only fallback

	s := mcpserver.New(claudeHome, st, emb)
	return server.ServeStdio(s)
}

func runAnalyze() error {
	fmt.Println("analyze command is being redesigned. Use /alfred:review via MCP instead.")
	return nil
}

// hookEvent is the minimal structure of a Claude Code hook stdin payload.
// Fields vary by event type; unused fields are zero values.
type hookEvent struct {
	SessionID   string          `json:"session_id"`
	ProjectPath string          `json:"cwd"`
	ToolName    string          `json:"tool_name"`
	ToolError   bool            `json:"tool_error"`
	Prompt      json.RawMessage `json:"prompt,omitempty"`
}

// runHook handles hook events. Most are silent data collection;
// UserPromptSubmit may emit additionalContext with project memory and tool hints.
func runHook(event string) error {
	var ev hookEvent
	if err := json.NewDecoder(os.Stdin).Decode(&ev); err != nil {
		// Malformed input — silently ignore (butler never complains).
		return nil
	}

	if event == "UserPromptSubmit" {
		prompt := promptText(ev.Prompt)
		var parts []string

		if hint := matchAlfredHint(prompt); hint != "" {
			parts = append(parts, hint)
		}
		if ctx := buildProjectContext(prompt); ctx != "" {
			parts = append(parts, ctx)
		}

		if len(parts) > 0 {
			fmt.Print(strings.Join(parts, "\n"))
		}
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
			ingestProjectClaudeMD(st, ev.ProjectPath)
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

// ---------------------------------------------------------------------------
// UserPromptSubmit: project context + alfred tool hint
// ---------------------------------------------------------------------------

// buildProjectContext returns past decision context for files mentioned in the prompt.
// Returns empty string if no relevant decisions found (butler stays quiet).
func buildProjectContext(prompt string) string {
	paths := store.ExtractFilePaths(prompt)
	if len(paths) == 0 {
		return ""
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		return ""
	}

	var hints []string
	for _, p := range paths {
		if len(hints) >= 3 {
			break
		}
		decisions, err := st.SearchDecisionsByFile(p, 2)
		if err != nil || len(decisions) == 0 {
			continue
		}
		for _, d := range decisions {
			hints = append(hints, d.DecisionText)
			if len(hints) >= 3 {
				break
			}
		}
	}

	if len(hints) == 0 {
		return ""
	}

	// Truncate each hint to keep total context reasonable.
	for i, h := range hints {
		if len(h) > 150 {
			hints[i] = h[:147] + "..."
		}
	}

	return "Past decisions about referenced files: " + strings.Join(hints, " | ")
}

// promptText extracts the user's message from the hook payload.
// Handles both object form {"message":"text"} and plain string.
func promptText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var obj struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &obj) == nil && obj.Message != "" {
		return obj.Message
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

// Keyword lists for detecting alfred-relevant prompts.
var (
	reviewActions = []string{
		"レビュー", "review", "分析", "改善", "チェック",
		"audit", "監査", "診断", "evaluate", "評価",
	}
	claudeCodeSubjects = []string{
		// core config files
		"skill", "スキル", "hook", "フック", "rule", "ルール",
		"claude.md", "agent", "エージェント",
		// infrastructure
		"mcp", "plugin", "プラグイン",
		"memory", "メモリ", "memory.md",
		// setup / workflow
		"setup", "セットアップ", "settings.json",
		"worktree", "ワークツリー",
		// concepts
		"claude code", "プロンプト設計", "prompt engineering",
		"コンテキスト", "context window",
		"permission", "パーミッション",
		"slash command", "スラッシュコマンド",
	}
	knowledgeTriggers = []string{
		"ベストプラクティス", "best practice",
	}
)

const (
	reviewHint    = "alfred review tool is available for analyzing Claude Code configuration (skills, rules, hooks, MCP). Consider using it before manually reading files."
	knowledgeHint = "alfred knowledge tool is available for searching Claude Code documentation and best practices."
)

// matchAlfredHint returns a context hint if the prompt matches known patterns,
// or empty string for silent pass-through (butler stays quiet by default).
func matchAlfredHint(prompt string) string {
	if prompt == "" {
		return ""
	}
	lower := strings.ToLower(prompt)

	// Pattern 1: review/analysis action targeting Claude Code configuration.
	if containsAny(lower, reviewActions) && containsAny(lower, claudeCodeSubjects) {
		return reviewHint
	}

	// Pattern 2: explicit best-practices / documentation search.
	if containsAny(lower, knowledgeTriggers) {
		return knowledgeHint
	}

	return ""
}

func containsAny(s string, words []string) bool {
	for _, w := range words {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// SessionStart: CLAUDE.md auto-ingest
// ---------------------------------------------------------------------------

type mdSection struct {
	Path    string
	Content string
}

// splitMarkdownSections splits markdown by ## headers (or # for root).
func splitMarkdownSections(md string) []mdSection {
	lines := strings.Split(md, "\n")
	var sections []mdSection
	var currentPath string
	var buf strings.Builder

	flush := func() {
		content := strings.TrimSpace(buf.String())
		if currentPath != "" && content != "" {
			sections = append(sections, mdSection{Path: currentPath, Content: content})
		}
		buf.Reset()
	}

	for _, line := range lines {
		if strings.HasPrefix(line, "## ") {
			flush()
			currentPath = strings.TrimSpace(strings.TrimPrefix(line, "## "))
		} else if strings.HasPrefix(line, "# ") && currentPath == "" {
			currentPath = strings.TrimSpace(strings.TrimPrefix(line, "# "))
		} else {
			if currentPath != "" {
				buf.WriteString(line)
				buf.WriteByte('\n')
			}
		}
	}
	flush()
	return sections
}

// ingestProjectClaudeMD reads CLAUDE.md from the project root and upserts
// each markdown section into the docs table for knowledge search.
// Silently skips if the file doesn't exist or is empty.
func ingestProjectClaudeMD(st *store.Store, projectPath string) {
	claudeMD := filepath.Join(projectPath, "CLAUDE.md")
	content, err := os.ReadFile(claudeMD)
	if err != nil {
		return // CLAUDE.md doesn't exist or unreadable — silently skip
	}

	sections := splitMarkdownSections(string(content))
	if len(sections) == 0 {
		return
	}

	url := "project://" + projectPath + "/CLAUDE.md"
	for _, sec := range sections {
		st.UpsertDoc(&store.DocRow{
			URL:         url,
			SectionPath: sec.Path,
			Content:     sec.Content,
			SourceType:  "project",
			TTLDays:     1,
		})
	}
}

func printUsage() {
	fmt.Println(`alfred - Your silent butler for Claude Code

Usage:
  alfred [command]

Commands:
  watch          Monitor active Claude Code session in real-time (default)
  browse         Browse past session history
  serve          Run as MCP server (stdio) for Claude Code integration
  hook           Handle silent hook events (no output)
  install        Set up alfred (skills, hooks, MCP, rules, DB sync)
  uninstall      Remove alfred completely (hooks, MCP, skills, rules, DB, binary)
  analyze        Project analysis report
  crawl-seed     Crawl official docs and generate seed_docs.json
  plugin-bundle  Generate plugin directory from Go sources
  version        Show version
  help           Show this help

Environment:
  VOYAGE_API_KEY  Optional. Enables semantic vector search (hybrid RRF + reranking).
                  Without it, search falls back to FTS5-only.`)
}
