package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestGeneratePluginBundle(t *testing.T) {
	// Not parallel: mutates package-level pluginDirFunc.

	// Override pluginDir to use temp dir.
	dir := t.TempDir()
	origFunc := pluginDirFunc
	pluginDirFunc = func() string { return dir }
	t.Cleanup(func() { pluginDirFunc = origFunc })

	if err := generatePluginBundle(); err != nil {
		t.Fatalf("generatePluginBundle() = %v", err)
	}

	expectedFiles := []string{
		filepath.Join(".claude-plugin", "plugin.json"),
		".mcp.json",
		filepath.Join("hooks", "hooks.json"),
		filepath.Join("skills", "health", "SKILL.md"),
		filepath.Join("skills", "review", "SKILL.md"),
		filepath.Join("skills", "patterns", "SKILL.md"),
		filepath.Join("scripts", "buddy"),
	}

	for _, rel := range expectedFiles {
		path := filepath.Join(dir, rel)
		info, err := os.Stat(path)
		if err != nil {
			t.Errorf("expected file %s not found: %v", rel, err)
			continue
		}
		if info.Size() == 0 {
			t.Errorf("file %s is empty", rel)
		}
	}

	// Verify launcher is executable.
	info, _ := os.Stat(filepath.Join(dir, "scripts", "buddy"))
	if info.Mode()&0o111 == 0 {
		t.Error("scripts/buddy is not executable")
	}
}

func TestPluginJSON_ValidJSON(t *testing.T) {
	t.Parallel()

	var m map[string]any
	if err := json.Unmarshal([]byte(pluginJSON), &m); err != nil {
		t.Fatalf("pluginJSON is invalid JSON: %v", err)
	}
	if m["name"] != "claude-buddy" {
		t.Errorf("name = %v, want claude-buddy", m["name"])
	}
}

func TestHooksJSON_ValidJSON(t *testing.T) {
	t.Parallel()

	var m map[string]any
	if err := json.Unmarshal([]byte(hooksJSON), &m); err != nil {
		t.Fatalf("hooksJSON is invalid JSON: %v", err)
	}
	hooks, ok := m["hooks"].(map[string]any)
	if !ok {
		t.Fatal("hooks key missing or not object")
	}

	expectedEvents := []string{"SessionStart", "PreToolUse", "PostToolUse", "UserPromptSubmit", "PreCompact", "SessionEnd"}
	for _, ev := range expectedEvents {
		if _, ok := hooks[ev]; !ok {
			t.Errorf("hook event %s missing", ev)
		}
	}
}

func TestPluginBundleIdempotent(t *testing.T) {
	// Not parallel: mutates package-level pluginDirFunc.

	dir := t.TempDir()
	origFunc := pluginDirFunc
	pluginDirFunc = func() string { return dir }
	t.Cleanup(func() { pluginDirFunc = origFunc })

	if err := generatePluginBundle(); err != nil {
		t.Fatalf("first call: %v", err)
	}

	data1, _ := os.ReadFile(filepath.Join(dir, ".claude-plugin", "plugin.json"))

	if err := generatePluginBundle(); err != nil {
		t.Fatalf("second call: %v", err)
	}

	data2, _ := os.ReadFile(filepath.Join(dir, ".claude-plugin", "plugin.json"))

	if string(data1) != string(data2) {
		t.Error("plugin.json changed on second call; expected idempotent")
	}
}
