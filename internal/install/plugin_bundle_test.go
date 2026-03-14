package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBundle(t *testing.T) {
	t.Parallel()
	outputDir := t.TempDir()

	if err := Bundle(outputDir, "0.30.0-test"); err != nil {
		t.Fatalf("Bundle() error: %v", err)
	}

	// Verify plugin.json exists and has correct structure.
	t.Run("plugin.json", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join(outputDir, ".claude-plugin", "plugin.json"))
		if err != nil {
			t.Fatalf("read plugin.json: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("parse plugin.json: %v", err)
		}
		if got := m["name"]; got != "alfred" {
			t.Errorf("name = %v, want alfred", got)
		}
		if got := m["version"]; got != "0.30.0-test" {
			t.Errorf("version = %v, want 0.30.0-test", got)
		}
	})

	// Verify hooks.json has expected events.
	t.Run("hooks.json", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join(outputDir, "hooks", "hooks.json"))
		if err != nil {
			t.Fatalf("read hooks.json: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("parse hooks.json: %v", err)
		}
		hooks, ok := m["hooks"].(map[string]any)
		if !ok {
			t.Fatal("hooks key missing or wrong type")
		}

		for _, event := range []string{"SessionStart", "PreCompact", "UserPromptSubmit", "SessionEnd"} {
			if _, ok := hooks[event]; !ok {
				t.Errorf("missing event: %s", event)
			}
		}
		if len(hooks) != 6 {
			t.Errorf("expected 6 hook events, got %d", len(hooks))
		}

		// Verify SessionEnd has matcher excluding clear.
		if sessionEnd, ok := hooks["SessionEnd"].([]any); ok && len(sessionEnd) > 0 {
			if entry, ok := sessionEnd[0].(map[string]any); ok {
				matcher, _ := entry["matcher"].(string)
				if matcher == "" {
					t.Error("SessionEnd should have a matcher to exclude reason=clear")
				}
				if strings.Contains(matcher, "clear") {
					t.Errorf("SessionEnd matcher should not include clear, got %q", matcher)
				}
			}
		}

		// All hook commands should use ${CLAUDE_PLUGIN_ROOT}.
		content := string(data)
		if !strings.Contains(content, "${CLAUDE_PLUGIN_ROOT}") {
			t.Error("hook commands should use ${CLAUDE_PLUGIN_ROOT}")
		}
	})

	// Verify .mcp.json.
	t.Run("mcp.json", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join(outputDir, ".mcp.json"))
		if err != nil {
			t.Fatalf("read .mcp.json: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("parse .mcp.json: %v", err)
		}
		servers, ok := m["mcpServers"].(map[string]any)
		if !ok {
			t.Fatal("mcpServers key missing")
		}
		if _, ok := servers["alfred"]; !ok {
			t.Error("alfred server missing from .mcp.json")
		}
	})

	// Verify all skills exist.
	t.Run("skills", func(t *testing.T) {
		for _, skill := range loadSkills() {
			p := filepath.Join(outputDir, "skills", skill.Dir, "SKILL.md")
			data, err := os.ReadFile(p)
			if err != nil {
				t.Errorf("skill %s: %v", skill.Dir, err)
				continue
			}
			if len(data) == 0 {
				t.Errorf("skill %s: empty file", skill.Dir)
			}
		}
	})

	// Verify agent exists.
	t.Run("agent", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join(outputDir, "agents", "alfred.md"))
		if err != nil {
			t.Fatalf("read alfred.md: %v", err)
		}
		if len(data) == 0 {
			t.Error("alfred.md is empty")
		}
	})

	// Verify run.sh is a simple delegator.
	t.Run("run.sh", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join(outputDir, "bin", "run.sh"))
		if err != nil {
			t.Fatalf("read run.sh: %v", err)
		}
		content := string(data)
		if !strings.Contains(content, "exec alfred") {
			t.Error("run.sh should delegate to alfred")
		}
	})
}

func TestBundleIdempotent(t *testing.T) {
	t.Parallel()
	outputDir := t.TempDir()

	// Run twice — should succeed both times.
	if err := Bundle(outputDir, "1.0.0"); err != nil {
		t.Fatalf("first Bundle() error: %v", err)
	}
	if err := Bundle(outputDir, "1.0.1"); err != nil {
		t.Fatalf("second Bundle() error: %v", err)
	}

	// Verify version was updated.
	data, err := os.ReadFile(filepath.Join(outputDir, ".claude-plugin", "plugin.json"))
	if err != nil {
		t.Fatalf("read plugin.json: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse plugin.json: %v", err)
	}
	if got := m["version"]; got != "1.0.1" {
		t.Errorf("version = %v, want 1.0.1", got)
	}
}

func TestInstallUserRules(t *testing.T) {
	// Not parallel: modifies HOME env var.
	home := t.TempDir()
	t.Setenv("HOME", home)

	// First install: should write all rule files.
	n, err := InstallUserRules()
	if err != nil {
		t.Fatalf("InstallUserRules() error: %v", err)
	}
	if n == 0 {
		t.Fatal("InstallUserRules() returned 0 files on first install")
	}

	rulesDir := filepath.Join(home, ".claude", "rules")
	entries, err := os.ReadDir(rulesDir)
	if err != nil {
		t.Fatalf("read rules dir: %v", err)
	}

	// All files should have alfred prefix.
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), "alfred") {
			t.Errorf("rule file %q should have alfred prefix", e.Name())
		}
	}

	// Verify content is non-empty.
	for _, e := range entries {
		data, err := os.ReadFile(filepath.Join(rulesDir, e.Name()))
		if err != nil {
			t.Errorf("read %s: %v", e.Name(), err)
		}
		if len(data) == 0 {
			t.Errorf("rule file %s is empty", e.Name())
		}
	}

	// Second install: should skip all (content unchanged).
	n2, err := InstallUserRules()
	if err != nil {
		t.Fatalf("InstallUserRules() second call error: %v", err)
	}
	if n2 != 0 {
		t.Errorf("InstallUserRules() second call = %d, want 0 (unchanged)", n2)
	}

	// Stale file should be cleaned by deprecated list.
	stale := filepath.Join(rulesDir, "alfred-butler-protocol.md")
	if err := os.WriteFile(stale, []byte("old"), 0o644); err != nil {
		t.Fatalf("write stale file: %v", err)
	}
	_, err = InstallUserRules()
	if err != nil {
		t.Fatalf("InstallUserRules() cleanup call error: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("deprecated rule file should have been removed")
	}
}
