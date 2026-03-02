package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// debugWriter is set when ALFRED_DEBUG is non-empty.
// Log file: ~/.claude-alfred/debug.log
var debugWriter io.Writer

func init() {
	if os.Getenv("ALFRED_DEBUG") == "" {
		return
	}
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".claude-alfred")
	_ = os.MkdirAll(dir, 0755)
	f, err := os.OpenFile(filepath.Join(dir, "debug.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	debugWriter = f
}

func debugf(format string, args ...any) {
	if debugWriter == nil {
		return
	}
	fmt.Fprintf(debugWriter, time.Now().Format("15:04:05.000")+" "+format+"\n", args...)
}

// hookEvent is the minimal structure of a Claude Code hook stdin payload.
// Fields vary by event type; unused fields are zero values.
type hookEvent struct {
	SessionID            string          `json:"session_id"`
	ProjectPath          string          `json:"cwd"`
	ToolName             string          `json:"tool_name"`
	ToolError            bool            `json:"tool_error"`
	Prompt               json.RawMessage `json:"prompt,omitempty"`
	StopHookActive       bool            `json:"stop_hook_active"`
	LastAssistantMessage string          `json:"last_assistant_message"`
	Source               string          `json:"source"`
}

// runHook handles hook events. Most are silent data collection;
// UserPromptSubmit may emit additionalContext with project memory and tool hints.
func runHook(event string) error {
	debugf("hook event=%s", event)
	var ev hookEvent
	if err := json.NewDecoder(os.Stdin).Decode(&ev); err != nil {
		debugf("hook decode error: %v", err)
		return nil
	}
	debugf("hook session=%s project=%s", ev.SessionID, ev.ProjectPath)

	if event == "UserPromptSubmit" {
		prompt := promptText(ev.Prompt)
		var parts []string

		if hint := matchAlfredHint(prompt); hint != "" {
			debugf("hook hint matched: %s", hint[:min(len(hint), 60)])
			parts = append(parts, hint)
		}
		st, _ := store.OpenDefaultCached()
		if ctx := buildProjectContext(st, prompt); ctx != "" {
			debugf("hook project context: %d chars", len(ctx))
			parts = append(parts, ctx)
		}

		if len(parts) > 0 {
			fmt.Print(strings.Join(parts, "\n"))
		}
		return nil
	}

	st, err := store.OpenDefaultCached()
	if err != nil {
		debugf("hook store open failed: %v", err)
		return nil
	}

	switch event {
	case "SessionStart":
		if ev.SessionID != "" && ev.ProjectPath != "" {
			_ = st.EnsureSession(ev.SessionID, ev.ProjectPath)
			ingestProjectClaudeMD(st, ev.ProjectPath)
		}
		if ev.Source == "compact" && ev.SessionID != "" {
			if ctx := buildCompactContext(st, ev.SessionID); ctx != "" {
				fmt.Print(ctx)
			}
		}
		if ev.Source != "compact" && ev.SessionID != "" && ev.ProjectPath != "" {
			if ctx := buildSessionStartContext(st, ev.SessionID, ev.ProjectPath); ctx != "" {
				fmt.Print(ctx)
			}
		}
	case "Stop":
		// StopHookActive is set when the Stop hook itself triggered a new Claude response,
		// preventing infinite re-entry loops.
		if !ev.StopHookActive && ev.LastAssistantMessage != "" && ev.SessionID != "" {
			extractAndSaveDecisions(st, ev.SessionID, ev.LastAssistantMessage)
		}
	case "SubagentStart":
		if ev.SessionID != "" {
			var parts []string
			if ctx := buildCompactContext(st, ev.SessionID); ctx != "" {
				parts = append(parts, ctx)
			}
			if sess, _ := st.GetSession(ev.SessionID); sess != nil {
				failures, _ := st.GetToolFailurePatterns(sess.ProjectPath, 3)
				if len(failures) > 0 {
					var items []string
					for _, f := range failures {
						items = append(items, fmt.Sprintf("%s (failed %dx)", f.ToolName, f.FailureCount))
					}
					parts = append(parts, "Tool failure patterns: "+strings.Join(items, ", "))
				}
			}
			if len(parts) > 0 {
				fmt.Print(strings.Join(parts, "\n\n"))
			}
		}
	case "SubagentStop":
		if ev.LastAssistantMessage != "" && ev.SessionID != "" {
			extractAndSaveDecisions(st, ev.SessionID, ev.LastAssistantMessage)
		}
	case "PostToolUseFailure":
		if ev.SessionID != "" && ev.ToolName != "" {
			_ = st.RecordToolUse(ev.SessionID, ev.ToolName, false)
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
// Accepts nil store (returns empty string).
func buildProjectContext(st *store.Store, prompt string) string {
	paths := store.ExtractFilePaths(prompt)
	if len(paths) == 0 {
		return ""
	}
	if st == nil {
		return ""
	}
	debugf("buildProjectContext: paths=%v", paths)

	var hints []string
	for _, p := range paths {
		if len(hints) >= 3 {
			break
		}
		decisions, err := st.SearchDecisionsByFile(p, 2)
		if err != nil {
			debugf("buildProjectContext: SearchDecisionsByFile(%s) error: %v", p, err)
			continue
		}
		if len(decisions) == 0 {
			continue
		}
		debugf("buildProjectContext: %d decisions for %s", len(decisions), p)
		for _, d := range decisions {
			hints = append(hints, d.DecisionText)
			if len(hints) >= 3 {
				break
			}
		}
	}

	// Co-changed files
	for _, p := range paths {
		if len(hints) >= 5 {
			break
		}
		coChanged, err := st.GetCoChangedFiles(p, 3)
		if err != nil || len(coChanged) == 0 {
			continue
		}
		var names []string
		for _, c := range coChanged {
			names = append(names, store.PathSuffix(c.Path))
		}
		hints = append(hints, fmt.Sprintf("Files often changed with %s: %s", store.PathSuffix(p), strings.Join(names, ", ")))
	}

	// Tool failure patterns
	failures, err := st.GetToolFailurePatterns(currentProjectPath(st), 3)
	if err == nil {
		for _, f := range failures {
			if len(hints) >= 7 {
				break
			}
			hints = append(hints, fmt.Sprintf("Note: %s has failed %d times recently", f.ToolName, f.FailureCount))
		}
	}

	if len(hints) == 0 {
		return ""
	}

	// Truncate each hint to keep total context reasonable.
	for i, h := range hints {
		if runes := []rune(h); len(runes) > 150 {
			hints[i] = string(runes[:147]) + "..."
		}
	}

	return "Past decisions about referenced files: " + strings.Join(hints, " | ")
}

func currentProjectPath(st *store.Store) string {
	latest, err := st.GetLatestSession("")
	if err != nil || latest == nil {
		return ""
	}
	return latest.ProjectPath
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
	reviewHint    = "alfred review tool is available for analyzing Claude Code configuration (skills, rules, hooks, MCP). Use it before manually reading multiple config files."
	knowledgeHint = "alfred knowledge tool is available for searching Claude Code documentation and best practices. Use it before answering Claude Code questions from general knowledge."
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
// Stop hook: rule-based decision extraction (async, silent)
// ---------------------------------------------------------------------------

// extractAndSaveDecisions extracts design decisions from the last assistant
// message using keyword pattern matching and saves them to the database.
func extractAndSaveDecisions(st *store.Store, sessionID, assistantText string) {
	ts := time.Now().UTC().Format(time.RFC3339)
	decisions := store.ExtractDecisions(assistantText, ts)
	debugf("extractAndSaveDecisions: %d decisions from %d chars", len(decisions), len(assistantText))
	for _, d := range decisions {
		d.SessionID = sessionID
		if err := st.InsertDecision(&d); err != nil {
			debugf("extractAndSaveDecisions: InsertDecision error: %v", err)
		}
	}
}

// ---------------------------------------------------------------------------
// SessionStart(compact): context re-injection
// ---------------------------------------------------------------------------

// buildCompactContext builds a context string with recent decisions and
// modified files from the session to re-inject after compaction.
// Returns empty string if nothing useful to inject.
func buildCompactContext(st *store.Store, sessionID string) string {
	decisions, _ := st.GetDecisions(sessionID, "", 5)
	files, _ := st.GetFilesWritten(sessionID, 15)

	if len(decisions) == 0 && len(files) == 0 {
		return ""
	}

	var b strings.Builder

	if len(decisions) > 0 {
		b.WriteString("## Decisions made this session\n")
		for _, d := range decisions {
			entry := fmt.Sprintf("- **%s**: %s", d.Topic, d.DecisionText)
			if d.Reasoning != "" {
				entry += " (" + d.Reasoning + ")"
			}
			runes := []rune(entry)
			if len(runes) > 400 {
				entry = string(runes[:397]) + "..."
			}
			b.WriteString(entry)
			b.WriteByte('\n')
		}
	}

	if len(files) > 0 {
		if len(decisions) > 0 {
			b.WriteByte('\n')
		}
		b.WriteString("## Files modified this session\n")
		for _, f := range files {
			fmt.Fprintf(&b, "- %s (%s)\n", f.Path, f.Action)
		}
	}

	// Hotspot warnings
	if sess, _ := st.GetSession(sessionID); sess != nil && sess.ProjectPath != "" {
		hotspots, _ := st.GetFileReworkHotspots(sess.ProjectPath, 3)
		if len(hotspots) > 0 {
			b.WriteString("\n## Frequently modified files\n")
			for i, h := range hotspots {
				if i >= 3 {
					break
				}
				fmt.Fprintf(&b, "- %s (changed in %d sessions)\n", store.PathSuffix(h.Path), h.SessionCount)
			}
		}
	}

	return b.String()
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

// ---------------------------------------------------------------------------
// SessionStart: session start context (non-compact)
// ---------------------------------------------------------------------------

// buildSessionStartContext provides context hints at session start (non-compact),
// including previous session quality warnings and file hotspots.
func buildSessionStartContext(st *store.Store, sessionID, projectPath string) string {
	var parts []string

	prev, err := st.GetLatestSession(projectPath)
	if err == nil && prev != nil && prev.ID != sessionID {
		if prev.CompactCount >= 3 {
			parts = append(parts, fmt.Sprintf("Previous session had %d context compactions. Consider splitting tasks into smaller sessions.", prev.CompactCount))
		}
	}

	hotspots, err := st.GetFileReworkHotspots(projectPath, 3)
	if err == nil && len(hotspots) > 0 {
		var items []string
		for _, h := range hotspots {
			if len(items) >= 3 {
				break
			}
			items = append(items, fmt.Sprintf("%s (%d sessions)", store.PathSuffix(h.Path), h.SessionCount))
		}
		if len(items) > 0 {
			parts = append(parts, "Frequently modified files: "+strings.Join(items, ", "))
		}
	}

	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, "\n")
}
