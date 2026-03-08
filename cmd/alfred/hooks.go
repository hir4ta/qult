package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/hir4ta/claude-alfred/internal/store"
)

// execCommand is a variable so tests can stub it out.
var execCommand = exec.Command

// debugWriter is set lazily on first debugf() call when ALFRED_DEBUG is non-empty.
// Log file: ~/.claude-alfred/debug.log
// The file handle is closed via closeDebugWriter() before process exit.
var debugWriter io.Writer
var debugFile *os.File // retained for explicit Close
var debugOnce sync.Once
var debugEnabled = os.Getenv("ALFRED_DEBUG") != ""

func debugf(format string, args ...any) {
	if !debugEnabled {
		return
	}
	debugOnce.Do(func() {
		home, _ := os.UserHomeDir()
		dir := filepath.Join(home, ".claude-alfred")
		_ = os.MkdirAll(dir, 0755)
		f, err := os.OpenFile(filepath.Join(dir, "debug.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return
		}
		debugFile = f
		debugWriter = f
	})
	if debugWriter == nil {
		return
	}
	fmt.Fprintf(debugWriter, time.Now().Format("15:04:05.000")+" "+format+"\n", args...)
}

// closeDebugWriter closes the debug log file handle if it was opened.
func closeDebugWriter() {
	if debugFile != nil {
		debugFile.Close()
	}
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
	Reason             string         `json:"reason"`              // SessionEnd: clear/logout/prompt_input_exit/other
	StopHookActive     bool           `json:"stop_hook_active"`
}

// configReminder is the additionalContext message injected when Claude Code
// accesses configuration files or the user's prompt mentions them.
const configReminder = `This task involves Claude Code configuration. alfred's MCP tools have specialized, up-to-date knowledge:
- knowledge: Best practices for .claude/ files, CLAUDE.md, hooks, skills, rules, agents, MCP
- config-review: Project-wide .claude/ configuration audit
Call these BEFORE reading or modifying configuration files directly.`

// notifyUser outputs a brief message to stderr so the user can see what
// alfred did. Stdout is reserved for hook protocol JSON.
func notifyUser(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[alfred] "+format+"\n", args...)
}

// emitAdditionalContext outputs a JSON response with additionalContext for
// UserPromptSubmit and SessionStart hooks. This is the recommended format
// per Claude Code docs — context is added more discretely than plain stdout.
func emitAdditionalContext(eventName, context string) {
	out := map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":     eventName,
			"additionalContext": context,
		},
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		debugf("emitAdditionalContext: json encode error: %v", err)
	}
}

// runHook handles hook events.
func runHook(event string) error {
	defer closeDebugWriter()
	store.DebugLog = debugf
	debugf("hook event=%s", event)
	var ev hookEvent
	if err := json.NewDecoder(os.Stdin).Decode(&ev); err != nil {
		// Fail-open: decode errors must not block Claude Code.
		// Hook protocol requires clean exit; errors are logged for debugging.
		debugf("hook decode error: %v", err)
		return nil
	}
	if ev.StopHookActive {
		debugf("hook stop_hook_active=true, exiting")
		return nil
	}
	debugf("hook project=%s", ev.ProjectPath)

	// Internal context timeout per hook event, slightly under Claude Code's
	// external timeout to allow graceful cleanup before SIGTERM.
	var timeout time.Duration
	switch event {
	case "SessionStart":
		timeout = 4500 * time.Millisecond // hooks.json: 5s
	case "PreCompact":
		timeout = 9 * time.Second // hooks.json: 10s
	case "PreToolUse":
		timeout = 1500 * time.Millisecond // hooks.json: 2s
	case "UserPromptSubmit":
		timeout = 2500 * time.Millisecond // hooks.json: 3s
	case "SessionEnd":
		timeout = 2500 * time.Millisecond // hooks.json: 3s
	default:
		timeout = 5 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	switch event {
	case "SessionStart":
		handleSessionStart(ctx, &ev)
	case "PreCompact":
		if ev.ProjectPath != "" {
			handlePreCompact(ctx, ev.ProjectPath, ev.TranscriptPath, ev.CustomInstructions)
		}
	case "PreToolUse":
		handlePreToolUse(&ev)
	case "UserPromptSubmit":
		handleUserPromptSubmit(ctx, &ev)
	case "SessionEnd":
		handleSessionEnd(ctx, &ev)
	}

	return nil
}

// ---------------------------------------------------------------------------
// Shared text utilities used by multiple hook handlers.
// ---------------------------------------------------------------------------

// extractSection extracts the content under a ## heading until the next ## heading.
func extractSection(content, heading string) string {
	lines := strings.Split(content, "\n")
	var result []string
	inSection := false
	for _, line := range lines {
		if line == heading || strings.HasPrefix(line, heading+" ") {
			inSection = true
			continue
		}
		if inSection && strings.HasPrefix(line, "## ") {
			break
		}
		if inSection {
			result = append(result, line)
		}
	}
	return strings.TrimSpace(strings.Join(result, "\n"))
}

// extractSectionFallback tries headings in order, returning the first non-empty match.
func extractSectionFallback(content string, headings ...string) string {
	for _, h := range headings {
		if s := extractSection(content, h); s != "" {
			return s
		}
	}
	return ""
}

// extractListItems extracts numbered or bulleted list items from a section.
func extractListItems(content, heading string) []string {
	section := extractSection(content, heading)
	if section == "" {
		return nil
	}
	var items []string
	for _, line := range strings.Split(section, "\n") {
		trimmed := strings.TrimSpace(line)
		// Strip leading "1. ", "2. ", "- " etc.
		if len(trimmed) > 2 {
			if trimmed[0] >= '0' && trimmed[0] <= '9' {
				if idx := strings.Index(trimmed, ". "); idx >= 0 && idx < 4 {
					items = append(items, trimmed[idx+2:])
					continue
				}
			}
			if strings.HasPrefix(trimmed, "- ") {
				items = append(items, trimmed[2:])
			}
		}
	}
	return items
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

// safeSnippet truncates content to maxRunes runes (UTF-8 safe).
// Unlike truncateStr, it preserves newlines and does not trim whitespace.
func safeSnippet(s string, maxRunes int) string {
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	return string(runes[:maxRunes]) + "..."
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
		return io.ReadAll(f)
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

// entryFromRaw constructs a transcriptEntry from an already-parsed map,
// avoiding a second json.Unmarshal on the same line.
func entryFromRaw(raw map[string]any) transcriptEntry {
	var e transcriptEntry
	e.Type, _ = raw["type"].(string)
	e.Role, _ = raw["role"].(string)
	e.Content = raw["content"]
	if msg, ok := raw["message"].(map[string]any); ok {
		e.Message.Role, _ = msg["role"].(string)
		e.Message.Content = msg["content"]
	}
	return e
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
