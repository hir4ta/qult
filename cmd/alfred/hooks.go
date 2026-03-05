package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/spec"
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
// Fields are populated depending on the event type:
//   - SessionStart: ProjectPath, Source, TranscriptPath
//   - PreCompact:   ProjectPath, TranscriptPath, Trigger, CustomInstructions
//   - PreToolUse:   ProjectPath, ToolName, ToolInput
//   - UserPromptSubmit: ProjectPath, Prompt
type hookEvent struct {
	ProjectPath        string         `json:"cwd"`
	Source             string         `json:"source"`              // SessionStart: startup/resume/clear/compact
	TranscriptPath     string         `json:"transcript_path"`     // path to conversation JSONL
	Trigger            string         `json:"trigger"`             // PreCompact: manual/auto
	CustomInstructions string         `json:"custom_instructions"` // PreCompact: user's /compact instructions
	ToolName           string         `json:"tool_name"`
	ToolInput          map[string]any `json:"tool_input"`
	Prompt             string         `json:"prompt"`
}

// configReminder is the additionalContext message injected when Claude Code
// accesses configuration files or the user's prompt mentions them.
const configReminder = `This task involves Claude Code configuration. alfred's MCP tools have specialized, up-to-date knowledge:
- knowledge: Best practices for .claude/ files, CLAUDE.md, hooks, skills, rules, agents, MCP
- review: Project-wide .claude/ configuration audit
Call these BEFORE reading or modifying configuration files directly.`

// runHook handles hook events.
func runHook(event string) error {
	debugf("hook event=%s", event)
	var ev hookEvent
	if err := json.NewDecoder(os.Stdin).Decode(&ev); err != nil {
		debugf("hook decode error: %v", err)
		return nil
	}
	debugf("hook project=%s", ev.ProjectPath)

	switch event {
	case "SessionStart":
		if ev.ProjectPath != "" {
			st, err := store.OpenDefaultCached()
			if err != nil {
				debugf("hook store open failed: %v", err)
				return nil
			}
			ingestProjectClaudeMD(st, ev.ProjectPath)

			// Inject butler-protocol context if active spec exists.
			// After compact, inject richer context for full recovery.
			injectButlerContext(ev.ProjectPath, ev.Source)
		}
	case "PreCompact":
		if ev.ProjectPath != "" {
			handlePreCompact(ev.ProjectPath, ev.TranscriptPath, ev.CustomInstructions)
		}
	case "PreToolUse":
		handlePreToolUse(&ev)
	case "UserPromptSubmit":
		handleUserPromptSubmit(&ev)
	}

	return nil
}

// ---------------------------------------------------------------------------
// PreToolUse: .claude/ config access reminder
// ---------------------------------------------------------------------------

// isClaudeConfigPath reports whether path refers to a Claude Code configuration
// file or directory (.claude/, CLAUDE.md, MEMORY.md, .mcp.json).
func isClaudeConfigPath(path string) bool {
	lower := strings.ToLower(path)
	return strings.Contains(lower, ".claude/") ||
		strings.Contains(lower, "claude.md") ||
		strings.Contains(lower, "memory.md") ||
		strings.Contains(lower, ".mcp.json")
}

// shouldRemind reports whether a tool's input targets Claude Code configuration.
// Checks file_path (Read/Edit/Write), path (Grep/Glob), and pattern (Glob).
func shouldRemind(toolInput map[string]any) bool {
	for _, key := range []string{"file_path", "path", "pattern"} {
		if v, ok := toolInput[key]; ok {
			if s, ok := v.(string); ok && s != "" {
				if isClaudeConfigPath(s) {
					return true
				}
			}
		}
	}
	return false
}

// handlePreToolUse emits a reminder when Claude accesses .claude/ config files.
func handlePreToolUse(ev *hookEvent) {
	if !shouldRemind(ev.ToolInput) {
		return
	}
	debugf("PreToolUse: reminding about alfred for %v", ev.ToolInput)
	fmt.Print(configReminder)
}

// ---------------------------------------------------------------------------
// UserPromptSubmit: Claude Code config keyword detection
// ---------------------------------------------------------------------------

// shouldRemindPrompt reports whether the user's prompt mentions Claude Code
// configuration paths (.claude, CLAUDE.md, MEMORY.md, .mcp.json).
func shouldRemindPrompt(prompt string) bool {
	lower := strings.ToLower(prompt)
	for _, term := range []string{".claude", "claude.md", "memory.md", ".mcp.json"} {
		if strings.Contains(lower, term) {
			return true
		}
	}
	return false
}

// handleUserPromptSubmit emits a reminder when the user mentions config paths.
func handleUserPromptSubmit(ev *hookEvent) {
	if !shouldRemindPrompt(ev.Prompt) {
		return
	}
	debugf("UserPromptSubmit: reminding about alfred for prompt")
	fmt.Print(configReminder)
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
	debugf("ingestProjectClaudeMD: %d sections from %s", len(sections), claudeMD)
}

// ---------------------------------------------------------------------------
// PreCompact: butler-protocol session persistence
// ---------------------------------------------------------------------------

// handlePreCompact saves session state before context compaction.
// This is the core of compact resilience — it reads the conversation transcript
// to extract key context (recent user messages, decisions, blockers) and saves
// them to session.md before the context is summarized.
func handlePreCompact(projectPath, transcriptPath, customInstructions string) {
	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		debugf("PreCompact: no active spec, skipping")
		return
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		debugf("PreCompact: spec dir missing for %s", taskSlug)
		return
	}

	// Extract recent conversation context from transcript.
	var contextSnapshot string
	if transcriptPath != "" {
		contextSnapshot = extractTranscriptContext(transcriptPath)
	}

	// Build compact marker with extracted context.
	var marker strings.Builder
	marker.WriteString(fmt.Sprintf("\n## Compact Marker [%s]\n", time.Now().Format("2006-01-02 15:04:05")))
	if customInstructions != "" {
		marker.WriteString(fmt.Sprintf("User compact instructions: %s\n", customInstructions))
	}
	if contextSnapshot != "" {
		marker.WriteString("### Pre-Compact Context Snapshot\n")
		marker.WriteString(contextSnapshot)
		marker.WriteString("\n")
	}
	marker.WriteString("---\n")

	if err := sd.AppendFile(spec.FileSession, marker.String()); err != nil {
		debugf("PreCompact: append marker error: %v", err)
		return
	}

	// Sync session.md to DB (without embedder — hook is short-lived).
	st, err := store.OpenDefaultCached()
	if err != nil {
		debugf("PreCompact: DB open error: %v", err)
		return
	}
	if err := spec.SyncSingleFile(context.Background(), sd, spec.FileSession, st, nil); err != nil {
		debugf("PreCompact: sync error: %v", err)
		return
	}

	debugf("PreCompact: saved session for %s (context: %d bytes)", taskSlug, len(contextSnapshot))
}

// transcriptEntry represents a single line from the Claude Code conversation JSONL.
type transcriptEntry struct {
	Type    string `json:"type"`
	Role    string `json:"role"`
	Content any    `json:"content"` // string or []ContentBlock
	Message struct {
		Role    string `json:"role"`
		Content any    `json:"content"`
	} `json:"message"`
}

// extractTranscriptContext reads the tail of a conversation transcript and
// extracts the most valuable context: recent user messages, assistant summaries,
// and tool errors that would otherwise be lost during compaction.
func extractTranscriptContext(transcriptPath string) string {
	// Read last 64KB of transcript (conversation can be huge).
	data, err := readFileTail(transcriptPath, 64*1024)
	if err != nil {
		debugf("PreCompact: read transcript error: %v", err)
		return ""
	}

	lines := strings.Split(string(data), "\n")

	var userMessages []string
	var assistantSummaries []string
	var toolErrors []string

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || line[0] != '{' {
			continue
		}
		var entry transcriptEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}

		text := extractTextContent(entry)
		if text == "" {
			continue
		}

		switch {
		case entry.Type == "human" || entry.Role == "user" ||
			(entry.Message.Role == "user"):
			// Keep last 5 user messages.
			userMessages = append(userMessages, truncateStr(text, 200))
			if len(userMessages) > 5 {
				userMessages = userMessages[len(userMessages)-5:]
			}
		case entry.Type == "assistant" || entry.Role == "assistant" ||
			(entry.Message.Role == "assistant"):
			// Keep last 3 assistant summaries (first 150 chars only).
			summary := truncateStr(text, 150)
			assistantSummaries = append(assistantSummaries, summary)
			if len(assistantSummaries) > 3 {
				assistantSummaries = assistantSummaries[len(assistantSummaries)-3:]
			}
		case entry.Type == "tool_error" || entry.Type == "error":
			toolErrors = append(toolErrors, truncateStr(text, 150))
			if len(toolErrors) > 3 {
				toolErrors = toolErrors[len(toolErrors)-3:]
			}
		}
	}

	var buf strings.Builder
	if len(userMessages) > 0 {
		buf.WriteString("Recent user requests:\n")
		for _, m := range userMessages {
			buf.WriteString("- " + m + "\n")
		}
	}
	if len(assistantSummaries) > 0 {
		buf.WriteString("Recent assistant actions:\n")
		for _, s := range assistantSummaries {
			buf.WriteString("- " + s + "\n")
		}
	}
	if len(toolErrors) > 0 {
		buf.WriteString("Recent errors (dead ends):\n")
		for _, e := range toolErrors {
			buf.WriteString("- " + e + "\n")
		}
	}
	return buf.String()
}

// extractTextContent extracts readable text from a transcript entry.
// Handles both string content and structured content blocks.
func extractTextContent(entry transcriptEntry) string {
	// Try direct content field.
	if s, ok := entry.Content.(string); ok && s != "" {
		return s
	}
	// Try message.content field.
	if s, ok := entry.Message.Content.(string); ok && s != "" {
		return s
	}
	// Try content blocks (array of {type, text}).
	if blocks, ok := entry.Content.([]any); ok {
		for _, b := range blocks {
			if block, ok := b.(map[string]any); ok {
				if text, ok := block["text"].(string); ok && text != "" {
					return text
				}
			}
		}
	}
	if blocks, ok := entry.Message.Content.([]any); ok {
		for _, b := range blocks {
			if block, ok := b.(map[string]any); ok {
				if text, ok := block["text"].(string); ok && text != "" {
					return text
				}
			}
		}
	}
	return ""
}

// readFileTail reads the last n bytes of a file.
func readFileTail(path string, n int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, err
	}

	size := info.Size()
	if size <= n {
		return os.ReadFile(path)
	}

	buf := make([]byte, n)
	_, err = f.ReadAt(buf, size-n)
	if err != nil {
		return nil, err
	}

	// Skip to first complete line.
	if idx := strings.IndexByte(string(buf), '\n'); idx >= 0 {
		buf = buf[idx+1:]
	}
	return buf, nil
}

// truncateStr truncates a string to maxLen runes, adding "..." if truncated.
func truncateStr(s string, maxLen int) string {
	s = strings.TrimSpace(s)
	// Remove newlines for single-line output.
	s = strings.ReplaceAll(s, "\n", " ")
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen]) + "..."
}

// ---------------------------------------------------------------------------
// SessionStart: butler-protocol context injection
// ---------------------------------------------------------------------------

// injectButlerContext outputs spec content to stdout when an active
// butler-protocol spec exists. After compact, injects richer context
// (all 6 files) for full recovery. On normal startup, injects only session.md.
func injectButlerContext(projectPath, source string) {
	taskSlug, err := spec.ReadActive(projectPath)
	if err != nil {
		return // no active spec — silently skip
	}

	sd := &spec.SpecDir{ProjectPath: projectPath, TaskSlug: taskSlug}
	if !sd.Exists() {
		return
	}

	if source == "compact" {
		// After compact: inject all spec files for full context recovery.
		// This is the critical path — Claude has lost most conversation context.
		var buf strings.Builder
		buf.WriteString(fmt.Sprintf("\n--- Butler Protocol: Recovering Task '%s' (post-compact) ---\n", taskSlug))
		buf.WriteString("Read these spec files to restore full context:\n\n")

		// Recovery order: session → requirements → design → tasks → decisions → knowledge
		recoveryOrder := []spec.SpecFile{
			spec.FileSession,
			spec.FileRequirements,
			spec.FileDesign,
			spec.FileTasks,
			spec.FileDecisions,
			spec.FileKnowledge,
		}
		for _, f := range recoveryOrder {
			content, err := sd.ReadFile(f)
			if err != nil || strings.TrimSpace(content) == "" {
				continue
			}
			buf.WriteString(fmt.Sprintf("### %s\n%s\n\n", f, content))
		}
		buf.WriteString("--- End Butler Protocol ---\n")
		fmt.Fprint(os.Stdout, buf.String())
		debugf("SessionStart(compact): injected full butler context for %s", taskSlug)
	} else {
		// Normal startup/resume: inject session.md only (lightweight).
		session, err := sd.ReadFile(spec.FileSession)
		if err != nil || session == "" {
			return
		}
		fmt.Fprintf(os.Stdout, "\n--- Butler Protocol: Active Task '%s' ---\n%s\n--- End Butler Protocol ---\n", taskSlug, session)
		debugf("SessionStart(%s): injected session context for %s", source, taskSlug)
	}
}
