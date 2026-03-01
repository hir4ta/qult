package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func tempSettings(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	if content != "" {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func TestRegisterHooks(t *testing.T) {
	path := tempSettings(t, "")
	orig := settingsPathFunc
	settingsPathFunc = func() string { return path }
	t.Cleanup(func() { settingsPathFunc = orig })

	if err := registerHooks(); err != nil {
		t.Fatalf("registerHooks() = %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}

	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("parse settings: %v", err)
	}

	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		t.Fatal("hooks key missing or not object")
	}

	events := []string{"SessionStart", "PreToolUse", "PostToolUse", "UserPromptSubmit", "PreCompact", "SessionEnd"}
	for _, ev := range events {
		if _, ok := hooks[ev]; !ok {
			t.Errorf("hook event %s missing", ev)
		}
	}
}

func TestRegisterHooks_PreservesExisting(t *testing.T) {
	path := tempSettings(t, `{
  "permissions": {"allow": ["Write"]},
  "language": "Japanese"
}`)

	orig := settingsPathFunc
	settingsPathFunc = func() string { return path }
	t.Cleanup(func() { settingsPathFunc = orig })

	if err := registerHooks(); err != nil {
		t.Fatalf("registerHooks() = %v", err)
	}

	data, _ := os.ReadFile(path)
	var settings map[string]any
	json.Unmarshal(data, &settings)

	if settings["language"] != "Japanese" {
		t.Errorf("language = %v, want Japanese", settings["language"])
	}

	perms, ok := settings["permissions"].(map[string]any)
	if !ok {
		t.Fatal("permissions key lost")
	}
	if _, ok := perms["allow"]; !ok {
		t.Error("permissions.allow lost")
	}

	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		t.Fatal("hooks key missing")
	}
	if _, ok := hooks["SessionStart"]; !ok {
		t.Error("SessionStart hook missing")
	}
}

func TestRegisterHooks_Idempotent(t *testing.T) {
	path := tempSettings(t, "")
	orig := settingsPathFunc
	settingsPathFunc = func() string { return path }
	t.Cleanup(func() { settingsPathFunc = orig })

	if err := registerHooks(); err != nil {
		t.Fatalf("first call: %v", err)
	}

	data1, _ := os.ReadFile(path)

	if err := registerHooks(); err != nil {
		t.Fatalf("second call: %v", err)
	}

	data2, _ := os.ReadFile(path)

	if string(data1) != string(data2) {
		t.Error("settings.json changed on second call; expected idempotent")
	}
}

func TestRegisterHooks_PreservesOtherHooks(t *testing.T) {
	path := tempSettings(t, `{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {"type": "command", "command": "other-tool check", "timeout": 1}
        ]
      }
    ]
  }
}`)

	orig := settingsPathFunc
	settingsPathFunc = func() string { return path }
	t.Cleanup(func() { settingsPathFunc = orig })

	if err := registerHooks(); err != nil {
		t.Fatalf("registerHooks() = %v", err)
	}

	data, _ := os.ReadFile(path)
	var settings map[string]any
	json.Unmarshal(data, &settings)

	hooks := settings["hooks"].(map[string]any)
	preToolList, ok := hooks["PreToolUse"].([]any)
	if !ok {
		t.Fatal("PreToolUse is not a list")
	}

	// Should have 2 entries: other-tool + claude-alfred.
	if len(preToolList) != 2 {
		t.Errorf("PreToolUse has %d entries, want 2", len(preToolList))
	}

	// Verify other-tool entry is preserved.
	found := false
	for _, item := range preToolList {
		if !isAlfredHookEntry(item) {
			found = true
		}
	}
	if !found {
		t.Error("other-tool hook entry was lost")
	}
}

func TestRemoveHooks(t *testing.T) {
	path := tempSettings(t, "")
	orig := settingsPathFunc
	settingsPathFunc = func() string { return path }
	t.Cleanup(func() { settingsPathFunc = orig })

	// First register hooks.
	if err := registerHooks(); err != nil {
		t.Fatalf("registerHooks() = %v", err)
	}

	// Then remove them.
	if err := RemoveHooks(); err != nil {
		t.Fatalf("RemoveHooks() = %v", err)
	}

	data, _ := os.ReadFile(path)
	var settings map[string]any
	json.Unmarshal(data, &settings)

	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		t.Fatal("hooks key missing")
	}

	events := []string{"SessionStart", "PreToolUse", "PostToolUse", "UserPromptSubmit", "PreCompact", "SessionEnd"}
	for _, ev := range events {
		if _, ok := hooks[ev]; ok {
			t.Errorf("hook event %s still present after removal", ev)
		}
	}
}

func TestRemoveHooks_PreservesOtherHooks(t *testing.T) {
	path := tempSettings(t, "")
	orig := settingsPathFunc
	settingsPathFunc = func() string { return path }
	t.Cleanup(func() { settingsPathFunc = orig })

	// Register hooks + add another tool's hook.
	if err := registerHooks(); err != nil {
		t.Fatalf("registerHooks() = %v", err)
	}

	data, _ := os.ReadFile(path)
	var settings map[string]any
	json.Unmarshal(data, &settings)

	hooks := settings["hooks"].(map[string]any)
	preToolList := hooks["PreToolUse"].([]any)
	preToolList = append(preToolList, map[string]any{
		"matcher": "Bash",
		"hooks":   []any{map[string]any{"type": "command", "command": "other-tool check", "timeout": 1}},
	})
	hooks["PreToolUse"] = preToolList
	settings["hooks"] = hooks
	out, _ := json.MarshalIndent(settings, "", "  ")
	os.WriteFile(path, append(out, '\n'), 0o644)

	// Remove claude-alfred hooks.
	if err := RemoveHooks(); err != nil {
		t.Fatalf("RemoveHooks() = %v", err)
	}

	data, _ = os.ReadFile(path)
	json.Unmarshal(data, &settings)
	hooks = settings["hooks"].(map[string]any)

	preToolList, ok := hooks["PreToolUse"].([]any)
	if !ok || len(preToolList) != 1 {
		t.Fatalf("PreToolUse has %d entries, want 1", len(preToolList))
	}

	if isAlfredHookEntry(preToolList[0]) {
		t.Error("claude-alfred entry still present")
	}
}

func TestHasLegacyHooks(t *testing.T) {
	// Cannot use t.Parallel() — subtests mutate package-level settingsPathFunc.

	t.Run("no settings file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "settings.json")
		orig := settingsPathFunc
		settingsPathFunc = func() string { return path }
		t.Cleanup(func() { settingsPathFunc = orig })

		if hasLegacyHooks() {
			t.Error("hasLegacyHooks() = true, want false (no file)")
		}
	})

	t.Run("no hooks", func(t *testing.T) {
		path := tempSettings(t, `{"hooks": {}}`)
		orig := settingsPathFunc
		settingsPathFunc = func() string { return path }
		t.Cleanup(func() { settingsPathFunc = orig })

		if hasLegacyHooks() {
			t.Error("hasLegacyHooks() = true, want false (no alfred hooks)")
		}
	})

	t.Run("alfred hooks present", func(t *testing.T) {
		path := tempSettings(t, "")
		orig := settingsPathFunc
		settingsPathFunc = func() string { return path }
		t.Cleanup(func() { settingsPathFunc = orig })

		// Register hooks to create them.
		if err := registerHooks(); err != nil {
			t.Fatalf("registerHooks() = %v", err)
		}

		if !hasLegacyHooks() {
			t.Error("hasLegacyHooks() = false, want true")
		}
	})

	t.Run("other hooks only", func(t *testing.T) {
		path := tempSettings(t, `{
  "hooks": {
    "PreToolUse": [
      {"hooks": [{"type": "command", "command": "other-tool check"}]}
    ]
  }
}`)
		orig := settingsPathFunc
		settingsPathFunc = func() string { return path }
		t.Cleanup(func() { settingsPathFunc = orig })

		if hasLegacyHooks() {
			t.Error("hasLegacyHooks() = true, want false (other tool only)")
		}
	})
}

func TestAlfredHookEntries(t *testing.T) {
	t.Parallel()

	entries := alfredHookEntries("/usr/local/bin/claude-alfred")

	events := []string{
		"SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure",
		"UserPromptSubmit", "PreCompact", "SessionEnd",
		"SubagentStart", "SubagentStop", "Notification",
		"TeammateIdle", "TaskCompleted", "PermissionRequest",
	}
	for _, ev := range events {
		if _, ok := entries[ev]; !ok {
			t.Errorf("event %s missing from alfredHookEntries", ev)
		}
	}
	if len(entries) != len(events) {
		t.Errorf("alfredHookEntries() has %d events, want %d", len(entries), len(events))
	}

	// Verify commands contain the binary path (skip prompt-type hooks).
	for event, entry := range entries {
		list, ok := entry.([]any)
		if !ok || len(list) == 0 {
			t.Errorf("%s: entry is not a non-empty list", event)
			continue
		}
		m := list[0].(map[string]any)
		hooks := m["hooks"].([]any)
		hook := hooks[0].(map[string]any)
		hookType, _ := hook["type"].(string)
		if hookType == "prompt" {
			// Prompt hooks don't have a command field; verify they have a prompt.
			prompt, _ := hook["prompt"].(string)
			if prompt == "" {
				t.Errorf("%s: prompt hook has empty prompt", event)
			}
			continue
		}
		cmd := hook["command"].(string)
		if cmd != "/usr/local/bin/claude-alfred hook-handler "+event {
			t.Errorf("%s: command = %s", event, cmd)
		}
	}
}

func TestIsAlfredHookEntry(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		entry any
		want  bool
	}{
		{
			name: "alfred entry",
			entry: map[string]any{
				"hooks": []any{map[string]any{"type": "command", "command": "/usr/bin/claude-alfred hook-handler PreToolUse"}},
			},
			want: true,
		},
		{
			name: "other tool",
			entry: map[string]any{
				"hooks": []any{map[string]any{"type": "command", "command": "other-tool check"}},
			},
			want: false,
		},
		{
			name:  "nil entry",
			entry: nil,
			want:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := isAlfredHookEntry(tt.entry); got != tt.want {
				t.Errorf("isAlfredHookEntry() = %v, want %v", got, tt.want)
			}
		})
	}
}
