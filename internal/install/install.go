package install

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/store"
	"github.com/hir4ta/claude-alfred/internal/watcher"
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

// syncRange maps CLI flag values to durations and display labels.
type syncRange struct {
	Days  int
	Label string
}

var syncRanges = map[string]syncRange{
	"7d":  {7, "past week"},
	"14d": {14, "past 2 weeks"},
	"30d": {30, "past month"},
	"90d": {90, "past 3 months"},
}

// Run executes the install command. All steps are idempotent.
// Hooks, skills, agent, and MCP are managed by the plugin — this only
// syncs sessions/docs, generates embeddings, and ensures global rules.
// args may contain --since=7d|14d|30d|90d (default: 30d).
// Claude Code retains sessions for ~30 days (cleanupPeriodDays default),
// so 30d captures everything available.
func Run(args []string) error {
	sinceFlag := "30d"
	for _, a := range args {
		if strings.HasPrefix(a, "--since=") {
			sinceFlag = strings.TrimPrefix(a, "--since=")
		}
	}
	sr, ok := syncRanges[sinceFlag]
	if !ok {
		return fmt.Errorf("invalid --since value: %s (use 7d, 14d, 30d, or 90d)", sinceFlag)
	}

	// Clean up legacy files from pre-plugin installs (silent if nothing to clean).
	cleanupLegacyInstall()

	if err := initialSync(sr); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: initial sync failed: %v\n", err)
	}

	seedDocs()

	// OOBE: guide users when knowledge base needs content.
	if hint := docsOOBEHint(); hint != "" {
		fmt.Println(hint)
	}

	ensureRulesFile()
	ensurePathSymlink()

	fmt.Println("\n✓ Installation complete!")
	fmt.Println("\nIf you haven't set up the plugin yet:")
	fmt.Println("  /plugin marketplace add hir4ta/claude-alfred")
	fmt.Println("  /plugin install claude-alfred@claude-alfred")

	return nil
}

// CountSessions outputs total session count and estimated sync time as JSON.
func CountSessions() error {
	sessions, err := listAllSessions()
	if err != nil {
		return err
	}

	count := len(sessions)
	est := (count + 119) / 120 // ~0.5s per session ≈ 120 sessions/min, round up
	if est < 1 && count > 0 {
		est = 1
	}

	type output struct {
		Sessions   int `json:"sessions"`
		EstMinutes int `json:"est_minutes"`
	}
	out := output{
		Sessions:   count,
		EstMinutes: est,
	}
	return json.NewEncoder(os.Stdout).Encode(out)
}

// alfredRulesVersion tracks the rules content version for safe upgrades.
// Bump this when alfredRulesContent changes to trigger overwrites.
const alfredRulesVersion = "3"

// alfredRulesContent is the content written to ~/.claude/rules/alfred.md.
// 静観型執事: alfred never interrupts. Tools are called on demand.
// NOTE: Go raw string literals cannot contain backticks, so we use regular strings
// with explicit newlines for the rules content.
var alfredRulesContent = strings.Join([]string{
	"<!-- alfred-rules-v3 -->",
	"# claude-alfred",
	"",
	"alfred is a silent butler for Claude Code.",
	"He never interrupts your work. When you need him, he's ready.",
	"",
	"## MCP Tools",
	"",
	"**knowledge** — search Claude Code docs and best practices",
	"- Looking for how a Claude Code feature works",
	"- Need architectural guidance or best practice reference",
	"",
	"**review** — analyze project's Claude Code utilization",
	"- On-demand project health check",
	"- Compare setup against best practices",
	"",
	"**ingest** — store documentation in knowledge base",
	"- After crawling new documentation pages",
	"",
	"**preferences** — get/set user preferences",
	"- Record or retrieve user workflow preferences",
	"",
}, "\n")

// ensureRulesFile creates or updates ~/.claude/rules/alfred.md.
// Uses a version marker (<!-- alfred-rules-vN -->) to detect stale content.
// Files with the current version marker are left untouched.
func ensureRulesFile() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}

	rulesDir := filepath.Join(home, ".claude", "rules")
	rulesPath := filepath.Join(rulesDir, "alfred.md")

	// Check existing file for version marker.
	versionTag := "<!-- alfred-rules-v" + alfredRulesVersion + " -->"
	existing, readErr := os.ReadFile(rulesPath)
	if readErr == nil {
		if strings.Contains(string(existing), versionTag) {
			return // already current
		}
	}

	if err := os.MkdirAll(rulesDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to create rules dir: %v\n", err)
		return
	}

	content := versionTag + "\n" + alfredRulesContent
	if err := os.WriteFile(rulesPath, []byte(content), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to write rules file: %v\n", err)
		return
	}

	if readErr == nil {
		fmt.Println("✓ Updated ~/.claude/rules/alfred.md (v" + alfredRulesVersion + ")")
	} else {
		fmt.Println("✓ Created ~/.claude/rules/alfred.md")
	}
}

// cleanupLegacyInstall removes skills, agent, hooks, and MCP registration
// that were installed directly by the pre-plugin install flow.
// Silent if nothing to clean up.
func cleanupLegacyInstall() {
	var cleaned bool

	home, err := os.UserHomeDir()
	if err != nil {
		return
	}

	// Remove legacy skills.
	for _, skill := range alfredSkills {
		skillDir := filepath.Join(home, ".claude", "skills", skill.Dir)
		if _, err := os.Stat(skillDir); err == nil {
			cleaned = true
			break
		}
	}
	if cleaned {
		removeSkills()
	}

	// Remove legacy agent.
	agentPath := filepath.Join(home, ".claude", "agents", "alfred.md")
	if _, err := os.Stat(agentPath); err == nil {
		_ = os.Remove(agentPath)
		cleaned = true
	}

	// Remove legacy hooks from settings.json.
	if hasLegacyHooks() {
		_ = RemoveHooks()
		cleaned = true
	}

	// Remove legacy MCP registration.
	removeLegacyMCP()

	if cleaned {
		fmt.Println("✓ Cleaned up legacy skills/agent/hooks from ~/.claude/")
	}
}

// hasLegacyHooks checks if settings.json contains claude-alfred hooks.
func hasLegacyHooks() bool {
	data, err := os.ReadFile(settingsPathFunc())
	if err != nil {
		return false
	}
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		return false
	}
	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		return false
	}
	for _, event := range []string{"SessionStart", "PreToolUse", "PostToolUse"} {
		entries, ok := hooks[event].([]any)
		if !ok {
			continue
		}
		for _, entry := range entries {
			if isAlfredHookEntry(entry) {
				return true
			}
		}
	}
	return false
}

// removeLegacyMCP silently removes the MCP server registered via `claude mcp add`.
func removeLegacyMCP() {
	cmd := exec.Command("claude", "mcp", "remove", "-s", "user", "claude-alfred")
	_ = cmd.Run()
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

// alfredHookEntries builds hook event entries keyed by event name.
// 静観型執事: 3 silent hooks only — data collection, zero output.
func alfredHookEntries(binPath string) map[string]any {
	makeEntry := func(event string, timeout int) []any {
		hook := map[string]any{
			"type":    "command",
			"command": binPath + " hook " + event,
			"timeout": timeout,
		}
		return []any{map[string]any{"hooks": []any{hook}}}
	}

	return map[string]any{
		"SessionStart": makeEntry("SessionStart", 5),
		"PostToolUse":  makeEntry("PostToolUse", 3),
		"SessionEnd":   makeEntry("SessionEnd", 8),
	}
}

// registerHooks writes claude-alfred hooks to ~/.claude/settings.json.
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

	// Merge claude-alfred entries, preserving other tools' hooks.
	for event, entry := range alfredHookEntries(binPath) {
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

// mergeEventHooks replaces the claude-alfred entry in an event's hook list,
// preserving entries from other tools.
func mergeEventHooks(existing any, alfredEntry any) any {
	existingList, ok := existing.([]any)
	if !ok {
		return alfredEntry
	}

	alfredList, ok := alfredEntry.([]any)
	if !ok || len(alfredList) == 0 {
		return alfredEntry
	}

	// Filter out old claude-alfred entries, keep others.
	var kept []any
	for _, item := range existingList {
		if !isAlfredHookEntry(item) {
			kept = append(kept, item)
		}
	}

	return append(kept, alfredList...)
}

// isAlfredHookEntry checks if a hook entry belongs to claude-alfred
// by inspecting command strings and prompt markers.
func isAlfredHookEntry(entry any) bool {
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
		if strings.Contains(cmd, "claude-alfred") || strings.Contains(cmd, " hook-handler ") || strings.Contains(cmd, " hook ") {
			return true
		}
		// Check prompt hooks with [alfred] marker.
		prompt, _ := hm["prompt"].(string)
		if strings.Contains(prompt, "[alfred]") {
			return true
		}
	}
	return false
}

// RemoveHooks removes claude-alfred hooks from settings.json.
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

	// Current + legacy event names to clean up.
	events := []string{
		// Current (静観型執事)
		"SessionStart", "PostToolUse", "SessionEnd",
		// Legacy (removed in v1 reset)
		"PreToolUse", "PostToolUseFailure",
		"UserPromptSubmit", "PreCompact",
		"SubagentStart", "SubagentStop", "Notification",
		"TeammateIdle", "TaskCompleted", "PermissionRequest",
		"Stop",
	}
	changed := false
	for _, event := range events {
		existing, ok := hooks[event].([]any)
		if !ok {
			continue
		}

		var kept []any
		for _, item := range existing {
			if !isAlfredHookEntry(item) {
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

func listAllSessions() ([]watcher.SessionInfo, error) {
	claudeHome := watcher.DefaultClaudeHome()
	return watcher.ListSessions(claudeHome)
}

func initialSync(sr syncRange) error {
	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	since := time.Now().AddDate(0, 0, -sr.Days)
	fmt.Printf("Syncing sessions from the %s (parsing JSONL + extracting patterns)...\n", sr.Label)

	if err := st.SyncAllWithProgress(since, func(done, total int) {
		renderProgress("Syncing sessions", done, total)
	}); err != nil {
		return fmt.Errorf("sync: %w", err)
	}
	clearLine()

	var sessionCount, eventCount, docsCount int
	st.DB().QueryRow("SELECT COUNT(*) FROM sessions").Scan(&sessionCount)
	st.DB().QueryRow("SELECT COUNT(*) FROM events").Scan(&eventCount)
	st.DB().QueryRow("SELECT COUNT(*) FROM docs").Scan(&docsCount)

	fmt.Printf("✓ Synced sessions from %s (total: %d sessions, %d events, %d docs)\n", sr.Label, sessionCount, eventCount, docsCount)
	return nil
}

func seedDocs() {
	st, err := store.OpenDefault()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not open store for seed docs: %v\n", err)
		return
	}
	defer st.Close()

	emb, err := embedder.NewEmbedder()
	if err != nil {
		fmt.Fprintf(os.Stderr, "✘ %v\n", err)
		fmt.Fprintf(os.Stderr, "  Set VOYAGE_API_KEY to enable vector search (required).\n")
		return
	}
	fmt.Printf("✓ Embedder available (model: %s)\n", emb.Model())
	fmt.Println("  First-time embedding may take up to 15 minutes")

	res, err := ApplySeed(st, emb, func(done, total int) {
		renderProgress("Seeding docs", done, total)
	})
	clearLine()

	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: seed docs partially failed: %v\n", err)
	}

	if res.Applied > 0 {
		msg := fmt.Sprintf("✓ Seeded %d doc sections (%d unchanged)", res.Applied, res.Unchanged)
		if res.Embedded > 0 {
			msg += fmt.Sprintf(", %d embeddings generated", res.Embedded)
		}
		fmt.Println(msg)
	} else if res.Unchanged > 0 {
		fmt.Printf("✓ Docs already up to date (%d sections)\n", res.Unchanged)
	}
}

// docsOOBEHint checks the docs table and returns a helpful message
// if the knowledge base needs more content.
func docsOOBEHint() string {
	st, err := store.OpenDefault()
	if err != nil {
		return ""
	}
	defer st.Close()

	total, _, _, err := st.DocsStats()
	if err != nil {
		return ""
	}
	if total == 0 {
		return "\nKnowledge base is empty. Run /alfred-crawl in Claude Code to populate it with documentation.\n  This enables semantic search over Claude Code docs and changelog."
	}
	if total < 20 {
		return fmt.Sprintf("\nKnowledge base has only %d sections. Run /alfred-crawl for full documentation coverage.", total)
	}
	return ""
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

// ensurePathSymlink creates a symlink at ~/.local/bin/claude-alfred
// pointing to the current binary, so users can run claude-alfred from PATH.
func ensurePathSymlink() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return
	}
	linkPath := filepath.Join(binDir, "claude-alfred")

	// Check if symlink already points to the right target.
	if target, err := os.Readlink(linkPath); err == nil && target == exe {
		return
	}

	_ = os.Remove(linkPath)
	if err := os.Symlink(exe, linkPath); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not create symlink %s: %v\n", linkPath, err)
		return
	}
	fmt.Printf("✓ Symlink created: %s\n", linkPath)
	fmt.Printf("  Add ~/.local/bin to PATH if not already:\n")
	fmt.Printf("  export PATH=\"$HOME/.local/bin:$PATH\"\n")
}
