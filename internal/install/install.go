package install

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/embedder"
	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// settingsPathFunc returns the path to ~/.claude/settings.json.
// Package-level variable for test overrides.
var settingsPathFunc = defaultSettingsPath

func defaultSettingsPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".claude", "settings.json")
}

// Run executes the install command. All steps are idempotent.
func Run() error {
	if isPluginActive() {
		fmt.Println("Plugin mode detected — skipping hook/skill/agent registration")
		// Clean up legacy files that conflict with plugin-provided ones.
		cleanupLegacyInstall()
	} else {
		// Step 1: MCP registration.
		registerMCP()

		// Step 2: Write hooks to settings.json.
		if err := registerHooks(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: hook registration failed: %v\n", err)
		}

		// Step 3: Install buddy agent.
		if err := installBuddyAgent(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: buddy agent install failed: %v\n", err)
		}

		// Step 3b: Install buddy skills.
		if err := installSkills(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: skills install failed: %v\n", err)
		}
	}

	// Always run: DB sync, docs, embeddings.
	if err := initialSync(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: initial sync failed: %v\n", err)
	}

	if err := syncDocsToStore(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: docs knowledge sync failed: %v\n", err)
	}

	generateEmbeddings()

	if isPluginActive() {
		fmt.Println("\n✓ Installation complete! (plugin mode — hooks/skills managed by plugin)")
	} else {
		printInstructions()
	}

	return nil
}

// isPluginActive checks if claude-buddy is registered as a plugin
// by looking for "claude-buddy" in enabledPlugins of settings.json.
func isPluginActive() bool {
	data, err := os.ReadFile(settingsPathFunc())
	if err != nil {
		return false
	}
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		return false
	}
	plugins, ok := settings["enabledPlugins"].([]any)
	if !ok {
		return false
	}
	for _, p := range plugins {
		s, ok := p.(string)
		if ok && strings.Contains(s, "claude-buddy") {
			return true
		}
	}
	return false
}

// cleanupLegacyInstall removes skills, agent, and hooks that were installed
// directly to ~/.claude/ by the legacy install flow. When the plugin is active,
// these files are provided by the plugin cache and the legacy copies are redundant.
func cleanupLegacyInstall() {
	removeSkills()
	if home, err := os.UserHomeDir(); err == nil {
		agentPath := filepath.Join(home, ".claude", "agents", "buddy.md")
		_ = os.Remove(agentPath)
	}
	_ = RemoveHooks()
	fmt.Println("✓ Cleaned up legacy skills/agent/hooks from ~/.claude/")
}

func registerMCP() {
	binPath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not determine binary path: %v\n", err)
		return
	}

	cmd := exec.Command("claude", "mcp", "add", "-s", "user", "claude-buddy", "--", binPath, "serve")
	if output, err := cmd.CombinedOutput(); err != nil {
		fmt.Printf("Warning: MCP registration: %v (%s)\n", err, strings.TrimSpace(string(output)))
	} else {
		fmt.Println("✓ MCP server registered")
	}
}

// resolveBinPath returns the resolved absolute path of the current binary.
func resolveBinPath() (string, error) {
	binPath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("determine binary path: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(binPath)
	if err != nil {
		return binPath, nil // fall back to unresolved path
	}
	return resolved, nil
}

// buddyHookEntries builds hook event entries keyed by event name.
func buddyHookEntries(binPath string) map[string]any {
	makeEntry := func(event string, timeout int, async bool, matcher string) []any {
		hook := map[string]any{
			"type":    "command",
			"command": binPath + " hook-handler " + event,
			"timeout": timeout,
		}
		if async {
			hook["async"] = true
		}

		entry := map[string]any{
			"hooks": []any{hook},
		}
		if matcher != "" {
			entry["matcher"] = matcher
		}
		return []any{entry}
	}

	entries := map[string]any{
		"SessionStart":        makeEntry("SessionStart", 5, false, "startup|resume|compact"),
		"PreToolUse":          makeEntry("PreToolUse", 2, false, ""),
		"PostToolUse":         makeEntry("PostToolUse", 5, true, ""),
		"PostToolUseFailure":  makeEntry("PostToolUseFailure", 5, false, ""),
		"UserPromptSubmit":    makeEntry("UserPromptSubmit", 2, false, ""),
		"PreCompact":          makeEntry("PreCompact", 3, false, ""),
		"SessionEnd":          makeEntry("SessionEnd", 5, true, ""),
		"SubagentStart":       makeEntry("SubagentStart", 3, false, ""),
		"SubagentStop":        makeEntry("SubagentStop", 3, false, ""),
		"Notification":        makeEntry("Notification", 2, false, ""),
		"TeammateIdle":        makeEntry("TeammateIdle", 3, true, ""),
		"TaskCompleted":       makeEntry("TaskCompleted", 3, false, ""),
		"PermissionRequest":   makeEntry("PermissionRequest", 1, false, "buddy_*"),
	}

	// Stop: command hook (deterministic checks) + prompt hook (LLM verification).
	stopCommandEntry := makeEntry("Stop", 5, false, "")
	stopPromptEntry := []any{
		map[string]any{
			"hooks": []any{
				map[string]any{
					"type": "prompt",
					"prompt": "[buddy] Review the last assistant message. Check for:\n" +
						"(1) Unresolved errors mentioned but not fixed\n" +
						"(2) TODO items that should have been completed\n" +
						"(3) Tests mentioned but not run\n" +
						"(4) Compilation errors not addressed\n" +
						"(5) Multiple files modified without tests — suggest running tests\n" +
						"(6) Incomplete refactoring (partial changes that could break the codebase)\n" +
						"If all work appears complete and verified, allow stopping.\n" +
						"Otherwise block with the SPECIFIC issue that needs resolution.",
					"timeout": 10,
				},
			},
		},
	}
	entries["Stop"] = append(stopCommandEntry, stopPromptEntry...)

	return entries
}

// registerHooks writes claude-buddy hooks to ~/.claude/settings.json.
// Existing settings and hooks from other tools are preserved.
func registerHooks() error {
	binPath, err := resolveBinPath()
	if err != nil {
		return err
	}

	settingsPath := settingsPathFunc()

	// Read existing settings (or start with empty object).
	settings := make(map[string]any)
	data, err := os.ReadFile(settingsPath)
	if err == nil {
		if err := json.Unmarshal(data, &settings); err != nil {
			return fmt.Errorf("parse %s: %w", settingsPath, err)
		}
	}

	// Get or create hooks map.
	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		hooks = make(map[string]any)
	}

	// Merge claude-buddy entries, preserving other tools' hooks.
	for event, entry := range buddyHookEntries(binPath) {
		hooks[event] = mergeEventHooks(hooks[event], entry)
	}
	settings["hooks"] = hooks

	// Write back with indentation.
	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal settings: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(settingsPath), err)
	}

	if err := os.WriteFile(settingsPath, append(out, '\n'), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", settingsPath, err)
	}

	fmt.Println("✓ Hooks registered in ~/.claude/settings.json")
	return nil
}

// mergeEventHooks replaces the claude-buddy entry in an event's hook list,
// preserving entries from other tools.
func mergeEventHooks(existing any, buddyEntry any) any {
	existingList, ok := existing.([]any)
	if !ok {
		return buddyEntry
	}

	buddyList, ok := buddyEntry.([]any)
	if !ok || len(buddyList) == 0 {
		return buddyEntry
	}

	// Filter out old claude-buddy entries, keep others.
	var kept []any
	for _, item := range existingList {
		if !isBuddyHookEntry(item) {
			kept = append(kept, item)
		}
	}

	return append(kept, buddyList...)
}

// isBuddyHookEntry checks if a hook entry belongs to claude-buddy
// by inspecting command strings and prompt markers.
func isBuddyHookEntry(entry any) bool {
	m, ok := entry.(map[string]any)
	if !ok {
		return false
	}
	hooks, ok := m["hooks"].([]any)
	if !ok {
		return false
	}
	for _, h := range hooks {
		hm, ok := h.(map[string]any)
		if !ok {
			continue
		}
		// Check command hooks.
		cmd, _ := hm["command"].(string)
		if strings.Contains(cmd, "claude-buddy") || strings.Contains(cmd, " hook-handler ") {
			return true
		}
		// Check prompt hooks with [buddy] marker.
		prompt, _ := hm["prompt"].(string)
		if strings.Contains(prompt, "[buddy]") {
			return true
		}
	}
	return false
}

// RemoveHooks removes claude-buddy hooks from settings.json.
func RemoveHooks() error {
	settingsPath := settingsPathFunc()

	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return nil // no settings file, nothing to remove
	}

	settings := make(map[string]any)
	if err := json.Unmarshal(data, &settings); err != nil {
		return fmt.Errorf("parse %s: %w", settingsPath, err)
	}

	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		return nil // no hooks section
	}

	events := []string{
		"SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure",
		"UserPromptSubmit", "PreCompact", "SessionEnd", "Stop",
		"SubagentStart", "SubagentStop", "Notification",
		"TeammateIdle", "TaskCompleted", "PermissionRequest",
	}
	changed := false
	for _, event := range events {
		existing, ok := hooks[event].([]any)
		if !ok {
			continue
		}

		var kept []any
		for _, item := range existing {
			if !isBuddyHookEntry(item) {
				kept = append(kept, item)
			}
		}

		if len(kept) == 0 {
			delete(hooks, event)
		} else {
			hooks[event] = kept
		}
		changed = true
	}

	if !changed {
		return nil
	}

	settings["hooks"] = hooks
	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal settings: %w", err)
	}

	return os.WriteFile(settingsPath, append(out, '\n'), 0o644)
}

func initialSync() error {
	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	if err := st.SyncAllWithProgress(func(done, total int) {
		renderProgress("Syncing sessions", done, total)
	}); err != nil {
		return fmt.Errorf("sync: %w", err)
	}
	clearLine()

	var sessionCount, eventCount, patternCount int
	st.DB().QueryRow("SELECT COUNT(*) FROM sessions").Scan(&sessionCount)
	st.DB().QueryRow("SELECT COUNT(*) FROM events").Scan(&eventCount)
	st.DB().QueryRow("SELECT COUNT(*) FROM patterns").Scan(&patternCount)

	fmt.Printf("✓ Synced %d sessions (%d events, %d patterns)\n", sessionCount, eventCount, patternCount)
	return nil
}

func syncDocsToStore() error {
	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()
	return syncDocsKnowledge(st)
}

func generateEmbeddings() {
	lang := locale.Detect()
	model := embedder.ModelForLocale(lang.Code)
	emb := embedder.NewEmbedder("", model)

	ctx := context.Background()
	if !emb.EnsureAvailable(ctx) {
		fmt.Println("⚠ Ollama not available — vector search will not work until Ollama is running")
		return
	}

	st, err := store.OpenDefault()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: embedding failed: %v\n", err)
		return
	}
	defer st.Close()

	count, err := st.EmbedPending(func(text string) ([]float32, error) {
		return emb.EmbedForStorage(ctx, text)
	}, model, func(done, total int) {
		renderProgress("Generating embeddings", done, total)
	})
	if err != nil {
		clearLine()
		fmt.Fprintf(os.Stderr, "Warning: embedding failed: %v\n", err)
		return
	}
	clearLine()

	if count > 0 {
		fmt.Printf("✓ Generated %d embeddings (model: %s)\n", count, model)
	} else {
		fmt.Printf("✓ Embeddings up to date (model: %s)\n", model)
	}
}

func printInstructions() {
	fmt.Println(`
✓ Installation complete!

Next time you start Claude Code, hooks will be active automatically.
No additional configuration needed.

To uninstall:
  claude-buddy uninstall`)
}

func renderProgress(prefix string, done, total int) {
	if total == 0 {
		return
	}
	const barWidth = 25
	filled := min(barWidth*done/total, barWidth)
	bar := strings.Repeat("█", filled) + strings.Repeat("░", barWidth-filled)
	fmt.Printf("\r⏳ %s [%s] %d/%d", prefix, bar, done, total)
}

func clearLine() {
	fmt.Print("\r\033[K")
}
