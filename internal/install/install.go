package install

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/hir4ta/claude-buddy/internal/embedder"
	"github.com/hir4ta/claude-buddy/internal/store"
	"github.com/hir4ta/claude-buddy/internal/watcher"
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

	if err := syncDocsToStore(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: docs knowledge sync failed: %v\n", err)
	}

	generateEmbeddings()
	ensureRulesFile()

	fmt.Println("\n✓ Installation complete!")
	fmt.Println("\nIf you haven't set up the plugin yet:")
	fmt.Println("  /plugin marketplace add hir4ta/claude-buddy")
	fmt.Println("  /plugin install claude-buddy@claude-buddy")

	return nil
}

// CountSessions outputs session counts per sync range as JSON.
func CountSessions() error {
	sessions, err := listAllSessions()
	if err != nil {
		return err
	}

	type rangeInfo struct {
		Days       int  `json:"days"`
		Sessions   int  `json:"sessions"`
		EstMinutes int  `json:"est_minutes"`
	}
	type output struct {
		Ranges      []rangeInfo `json:"ranges"`
		HasVoyageKey bool       `json:"has_voyage_key"`
	}

	now := time.Now()
	days := []int{7, 14, 30, 90}
	var ranges []rangeInfo
	for _, d := range days {
		cutoff := now.AddDate(0, 0, -d)
		count := 0
		for _, s := range sessions {
			if !s.ModTime.Before(cutoff) {
				count++
			}
		}
		est := (count + 119) / 120 // ~0.5s per session ≈ 120 sessions/min, round up
		if est < 1 && count > 0 {
			est = 1
		}
		ranges = append(ranges, rangeInfo{Days: d, Sessions: count, EstMinutes: est})
	}

	out := output{
		Ranges:      ranges,
		HasVoyageKey: os.Getenv("VOYAGE_API_KEY") != "",
	}
	return json.NewEncoder(os.Stdout).Encode(out)
}

// buddyRulesVersion tracks the rules content version for safe upgrades.
// Bump this when buddyRulesContent changes to trigger overwrites.
const buddyRulesVersion = "2"

// buddyRulesContent is the content written to ~/.claude/rules/buddy.md.
// It instructs Claude Code to actively call buddy MCP tools when conditions are met.
// NOTE: Go raw string literals cannot contain backticks, so we use regular strings
// with explicit newlines for the rules content.
var buddyRulesContent = strings.Join([]string{
	"# claude-buddy",
	"",
	"buddy hooks inject context into every turn automatically.",
	"These rules tell you when to call buddy MCP tools yourself.",
	"",
	"## On Tool Failure",
	"",
	"When a tool fails or returns an error:",
	"1. Read the [buddy] hint in additionalContext — it has root cause analysis",
	"2. When the hint says \"call buddy_diagnose\", do so with the error text",
	"3. On repeated failure (2+ times), call `buddy_diagnose` before retrying",
	"   — buddy_diagnose surfaces past fixes and resolution diffs so you don't repeat mistakes",
	"",
	"## Tool Trigger Map",
	"",
	"Call these MCP tools when the condition matches:",
	"",
	"**buddy_diagnose** — call on any tool failure or error",
	"- Edit mismatch, compile error, test failure, non-zero exit",
	"- Same error appearing 2+ times — get root cause before retrying",
	"",
	"**buddy_knowledge** — call to search past patterns and solutions",
	"- Working on unfamiliar code or debugging a recurring pattern",
	"- Hook output shows a \"knowledge\" briefing — call to dig deeper",
	"- Looking for an architectural precedent or past design decision",
	"",
	"**buddy_state** — call to check session health",
	"- Many tool calls without visible progress",
	"- Hook output shows a health decline warning",
	"- Before a major refactoring decision (risk assessment)",
	"",
	"**buddy_guidance** — call for workflow recommendations",
	"- Switching to a new file or task",
	"- Before editing a high-blast-radius file",
	"- After completing a major milestone (what's next?)",
	"",
	"**buddy_feedback** — call to rate a suggestion (trains the model)",
	"- After acting on a [buddy] suggestion: rate helpful / not_helpful",
	"- After ignoring a suggestion that turned out wrong: rate misleading",
	"- Each rating directly improves future suggestion quality",
	"",
	"## Reading Hook Output",
	"",
	"- `[buddy]` lines are session intelligence — read them",
	"- Lines starting with → are actionable recommendations",
	"- `WHY:` explains the reasoning behind a suggestion",
	"- `IMPACT:` quantifies savings — prioritize high-impact items",
	"- `suggested_tool` in JSON output names the MCP tool to call next",
	"",
}, "\n")

// ensureRulesFile creates or updates ~/.claude/rules/buddy.md.
// Uses a version marker (<!-- buddy-rules-vN -->) to detect stale content.
// Files with the current version marker are left untouched.
func ensureRulesFile() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}

	rulesDir := filepath.Join(home, ".claude", "rules")
	rulesPath := filepath.Join(rulesDir, "buddy.md")

	// Check existing file for version marker.
	versionTag := "<!-- buddy-rules-v" + buddyRulesVersion + " -->"
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

	content := versionTag + "\n" + buddyRulesContent
	if err := os.WriteFile(rulesPath, []byte(content), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to write rules file: %v\n", err)
		return
	}

	if readErr == nil {
		fmt.Println("✓ Updated ~/.claude/rules/buddy.md (v" + buddyRulesVersion + ")")
	} else {
		fmt.Println("✓ Created ~/.claude/rules/buddy.md")
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
	for _, skill := range buddySkills {
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
	agentPath := filepath.Join(home, ".claude", "agents", "buddy.md")
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

// hasLegacyHooks checks if settings.json contains claude-buddy hooks.
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
			if isBuddyHookEntry(entry) {
				return true
			}
		}
	}
	return false
}

// removeLegacyMCP silently removes the MCP server registered via `claude mcp add`.
func removeLegacyMCP() {
	cmd := exec.Command("claude", "mcp", "remove", "-s", "user", "claude-buddy")
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
		"PreCompact":          makeEntry("PreCompact", 5, false, ""),
		"SessionEnd":          makeEntry("SessionEnd", 8, false, ""),
		"SubagentStart":       makeEntry("SubagentStart", 3, false, ""),
		"SubagentStop":        makeEntry("SubagentStop", 3, false, ""),
		"Notification":        makeEntry("Notification", 2, false, ""),
		"TeammateIdle":        makeEntry("TeammateIdle", 3, true, ""),
		"TaskCompleted":       makeEntry("TaskCompleted", 3, false, ""),
		"PermissionRequest":   makeEntry("PermissionRequest", 1, false, ""),
	}

	// Stop hooks: command hook persists session data + validates completeness,
	// agent hook verifies task completion before allowing Claude to stop.
	// Agent type is more reliable than prompt type at producing valid JSON
	// (prompt hooks have a known upstream bug: anthropics/claude-code#11947).
	cmd := binPath + " hook-handler Stop"
	entries["Stop"] = []any{
		map[string]any{
			"hooks": []any{
				map[string]any{
					"type":    "command",
					"command": cmd,
					"timeout": 8,
				},
				map[string]any{
					"type":    "agent",
					"prompt":  "[buddy] Check if the task is complete. Evaluate: (1) Were all requested changes implemented? (2) Were tests run if the project has tests? (3) Are there uncommitted changes that should be committed? If incomplete, state what remains in one sentence. If complete, confirm completion.",
					"timeout": 30,
				},
			},
		},
	}

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

	var sessionCount, eventCount, patternCount int
	st.DB().QueryRow("SELECT COUNT(*) FROM sessions").Scan(&sessionCount)
	st.DB().QueryRow("SELECT COUNT(*) FROM events").Scan(&eventCount)
	st.DB().QueryRow("SELECT COUNT(*) FROM patterns").Scan(&patternCount)

	fmt.Printf("✓ Synced sessions from %s (total: %d sessions, %d events, %d patterns)\n", sr.Label, sessionCount, eventCount, patternCount)
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
	emb := embedder.NewEmbedder()

	ctx := context.Background()
	if !emb.EnsureAvailable(ctx) {
		fmt.Println("⚠ VOYAGE_API_KEY not set — vector search will use text-based fallback")
		return
	}

	st, err := store.OpenDefault()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: embedding failed: %v\n", err)
		return
	}
	defer st.Close()

	model := emb.Model()
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
