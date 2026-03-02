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
// Called by the curl one-liner installer (install.sh) or directly via `alfred install`.
//
// Flags:
//
//	--since=7d|14d|30d|90d (default: 30d) — session sync range
//	--sync-only            — skip component registration (used by plugin run.sh)
func Run(args []string) error {
	sinceFlag := "30d"
	syncOnly := false
	for _, a := range args {
		if strings.HasPrefix(a, "--since=") {
			sinceFlag = strings.TrimPrefix(a, "--since=")
		}
		if a == "--sync-only" {
			syncOnly = true
		}
	}
	sr, ok := syncRanges[sinceFlag]
	if !ok {
		return fmt.Errorf("invalid --since value: %s (use 7d, 14d, 30d, or 90d)", sinceFlag)
	}

	if !syncOnly {
		fmt.Println("Installing alfred...")

		// Fast setup first — available immediately even if sync is interrupted.
		ensurePathSymlink()
		installSkills()
		installAgent()
		if err := registerHooks(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: hook registration: %v\n", err)
		}
		registerMCP()
		ensureRulesFile()
	}

	// Heavy operations — session sync and doc embedding.
	if err := initialSync(sr); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: session sync: %v\n", err)
	}

	seedDocs()

	if hint := docsOOBEHint(); hint != "" {
		fmt.Println(hint)
	}

	if syncOnly {
		return nil
	}

	fmt.Println("\n✓ Installation complete!")
	fmt.Println("  Restart Claude Code to activate.")
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
const alfredRulesVersion = "4"

// alfredRulesContent is the content written to ~/.claude/rules/alfred.md.
// 静観型執事: alfred never interrupts. Tools are called on demand.
// NOTE: Go raw string literals cannot contain backticks, so we use regular strings
// with explicit newlines for the rules content.
var alfredRulesContent = strings.Join([]string{
	"<!-- alfred-rules-v4 -->",
	"# claude-alfred",
	"",
	"alfred is a silent butler for Claude Code.",
	"He never interrupts your work. When you need him, he's ready.",
	"",
	"## MCP Tools",
	"",
	"**knowledge** — search Claude Code docs and best practices",
	"- USE when: Claude Code の機能・設定の使い方、ベストプラクティスを確認する",
	"- DO NOT USE when: 一般プログラミングの質問、プロジェクト固有コードの質問",
	"",
	"**recall** — recall project context from past sessions",
	"- USE when: ファイルの過去の変更理由・決定を調べる、プロジェクトの作業履歴を確認する",
	"",
	"**review** — analyze project's Claude Code utilization",
	"- USE when: Claude Code 設定（rules, skills, hooks, MCP, CLAUDE.md）のレビュー・改善",
	"- IMPORTANT: 設定ファイルを複数手動で読む前にまず review を実行すること",
	"- DO NOT USE when: 特定ファイル1つの中身を確認するだけ",
	"",
	"**ingest** — store documentation in knowledge base",
	"- USE when: ドキュメントページをクロールした後",
	"",
	"**preferences** — get/set user preferences",
	"- USE when: ユーザーのワークフロー設定を記録・取得する",
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
// 静観型執事: silent data collection + contextual hints on UserPromptSubmit.
func alfredHookEntries(binPath string) map[string]any {
	makeEntry := func(event string, timeout int) []any {
		hook := map[string]any{
			"type":    "command",
			"command": binPath + " hook " + event,
			"timeout": timeout,
		}
		return []any{map[string]any{"hooks": []any{hook}}}
	}

	makeAsyncEntry := func(event string, timeout int) []any {
		hook := map[string]any{
			"type":    "command",
			"command": binPath + " hook " + event,
			"timeout": timeout,
			"async":   true,
		}
		return []any{map[string]any{"hooks": []any{hook}}}
	}

	return map[string]any{
		"SessionStart":     makeEntry("SessionStart", 5),
		"PostToolUse":      makeEntry("PostToolUse", 3),
		"SessionEnd":       makeEntry("SessionEnd", 8),
		"UserPromptSubmit": makeEntry("UserPromptSubmit", 2),
		"Stop":             makeAsyncEntry("Stop", 30),
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

// registerMCP registers the alfred MCP server via `claude mcp add`.
// Uses the stable ~/.local/bin/alfred path if available, falling back
// to the current binary location.
func registerMCP() {
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not determine home dir for MCP: %v\n", err)
		return
	}

	// Prefer the PATH-stable location.
	binPath := filepath.Join(home, ".local", "bin", "alfred")
	if _, err := os.Stat(binPath); err != nil {
		binPath, err = resolveBinPath()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Warning: could not determine binary path for MCP: %v\n", err)
			return
		}
	}

	// Remove existing registrations (both old and current names).
	for _, name := range []string{"claude-alfred", "alfred"} {
		cmd := exec.Command("claude", "mcp", "remove", "-s", "user", name)
		_ = cmd.Run()
	}

	// Register MCP server.
	cmd := exec.Command("claude", "mcp", "add", "-s", "user", "alfred", "--", binPath, "serve")
	if output, err := cmd.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: MCP registration: %v (%s)\n", err, strings.TrimSpace(string(output)))
		fmt.Fprintf(os.Stderr, "  Register manually: claude mcp add -s user alfred -- %s serve\n", binPath)
		return
	}
	fmt.Println("✓ MCP server registered")
}

// ensurePathSymlink creates a symlink at ~/.local/bin/alfred pointing to the
// current binary. Skips if the binary is already at the target location
// (e.g., curl installer placed it there directly).
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
	linkPath := filepath.Join(binDir, "alfred")

	// Binary is already at the target location (curl install).
	if exe == linkPath {
		return
	}

	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return
	}

	// Check if symlink already points to the right target.
	if target, err := os.Readlink(linkPath); err == nil && target == exe {
		return
	}

	_ = os.Remove(linkPath)
	if err := os.Symlink(exe, linkPath); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not create symlink %s: %v\n", linkPath, err)
		return
	}
	fmt.Printf("✓ Symlink created: %s → %s\n", linkPath, exe)
}
