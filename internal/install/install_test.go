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

// expectedEvents is the set of hook events registered by alfred.
var expectedEvents = []string{"SessionStart", "PostToolUse", "SessionEnd", "UserPromptSubmit"}

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

	for _, ev := range expectedEvents {
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
    "PostToolUse": [
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
	postToolList, ok := hooks["PostToolUse"].([]any)
	if !ok {
		t.Fatal("PostToolUse is not a list")
	}

	// Should have 2 entries: other-tool + claude-alfred.
	if len(postToolList) != 2 {
		t.Errorf("PostToolUse has %d entries, want 2", len(postToolList))
	}

	// Verify other-tool entry is preserved.
	found := false
	for _, item := range postToolList {
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

	if err := registerHooks(); err != nil {
		t.Fatalf("registerHooks() = %v", err)
	}

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

	for _, ev := range expectedEvents {
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

	if err := registerHooks(); err != nil {
		t.Fatalf("registerHooks() = %v", err)
	}

	data, _ := os.ReadFile(path)
	var settings map[string]any
	json.Unmarshal(data, &settings)

	hooks := settings["hooks"].(map[string]any)
	postToolList := hooks["PostToolUse"].([]any)
	postToolList = append(postToolList, map[string]any{
		"matcher": "Bash",
		"hooks":   []any{map[string]any{"type": "command", "command": "other-tool check", "timeout": 1}},
	})
	hooks["PostToolUse"] = postToolList
	settings["hooks"] = hooks
	out, _ := json.MarshalIndent(settings, "", "  ")
	os.WriteFile(path, append(out, '\n'), 0o644)

	if err := RemoveHooks(); err != nil {
		t.Fatalf("RemoveHooks() = %v", err)
	}

	data, _ = os.ReadFile(path)
	json.Unmarshal(data, &settings)
	hooks = settings["hooks"].(map[string]any)

	postToolList, ok := hooks["PostToolUse"].([]any)
	if !ok || len(postToolList) != 1 {
		t.Fatalf("PostToolUse has %d entries, want 1", len(postToolList))
	}

	if isAlfredHookEntry(postToolList[0]) {
		t.Error("claude-alfred entry still present")
	}
}


func TestAlfredHookEntries(t *testing.T) {
	t.Parallel()

	entries := alfredHookEntries("/usr/local/bin/claude-alfred")

	for _, ev := range expectedEvents {
		if _, ok := entries[ev]; !ok {
			t.Errorf("event %s missing from alfredHookEntries", ev)
		}
	}
	if len(entries) != len(expectedEvents) {
		t.Errorf("alfredHookEntries() has %d events, want %d", len(entries), len(expectedEvents))
	}

	// Verify commands contain the binary path and use "hook" subcommand.
	for event, entry := range entries {
		list, ok := entry.([]any)
		if !ok || len(list) == 0 {
			t.Errorf("%s: entry is not a non-empty list", event)
			continue
		}
		m := list[0].(map[string]any)
		hooks := m["hooks"].([]any)
		hook := hooks[0].(map[string]any)
		cmd := hook["command"].(string)
		if cmd != "/usr/local/bin/claude-alfred hook "+event {
			t.Errorf("%s: command = %s, want %s", event, cmd, "/usr/local/bin/claude-alfred hook "+event)
		}
	}
}

func TestIsAlfredHookEntry(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		entry any
		want  bool
	}{
		{
			name: "alfred hook entry",
			entry: map[string]any{
				"hooks": []any{map[string]any{"type": "command", "command": "/usr/bin/claude-alfred hook PostToolUse"}},
			},
			want: true,
		},
		{
			name: "legacy alfred hook-handler entry",
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
