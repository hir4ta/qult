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

	if err := Bundle(outputDir, "0.15.0-test"); err != nil {
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
		if got := m["name"]; got != "claude-alfred" {
			t.Errorf("name = %v, want claude-alfred", got)
		}
		if got := m["version"]; got != "0.15.0-test" {
			t.Errorf("version = %v, want 0.15.0-test", got)
		}
	})

	// Verify hooks.json has all 13 events.
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

		expectedEvents := []string{
			"SessionStart", "PostToolUse", "SessionEnd",
		}
		for _, event := range expectedEvents {
			if _, ok := hooks[event]; !ok {
				t.Errorf("missing event: %s", event)
			}
		}

		// All hook commands should use ${CLAUDE_PLUGIN_ROOT}.
		raw, _ := os.ReadFile(filepath.Join(outputDir, "hooks", "hooks.json"))
		content := string(raw)
		if !strings.Contains(content, "${CLAUDE_PLUGIN_ROOT}") {
			t.Error("hook commands should use ${CLAUDE_PLUGIN_ROOT}")
		}
		if strings.Contains(content, "$HOME/.claude/plugins") {
			t.Error("hook commands should not use hardcoded $HOME path")
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
		if _, ok := servers["claude-alfred"]; !ok {
			t.Error("claude-alfred server missing from .mcp.json")
		}
	})

	// Verify all skills exist.
	t.Run("skills", func(t *testing.T) {
		for _, skill := range alfredSkills {
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
}

func TestRunScriptAutoDownload(t *testing.T) {
	t.Parallel()
	script := generateRunScript("1.2.3")

	checks := map[string]string{
		"version embedding":   `ALFRED_VERSION="1.2.3"`,
		"version sidecar":     ".alfred-version",
		"lock directory":      ".alfred-download.lock",
		"is_current function": "is_current()",
		"acquire_lock":        "acquire_lock()",
		"download_binary":     "download_binary()",
		"ensure_binary":       "ensure_binary",
		"serve case":          "serve)",
		"hook case":           "hook)",
		"setup case":          "setup)",
		"install marker":      ".alfred-installed-",
		"atomic temp dir":     ".alfred-dl.",
		"github releases url": "github.com/hir4ta/claude-alfred/releases/download",
		"stale lock cleanup":  "kill -0",
		"fallback to old bin": `[ -f "$ALFRED_BIN" ]`,
	}

	for name, keyword := range checks {
		if !strings.Contains(script, keyword) {
			t.Errorf("run.sh missing %s: expected to contain %q", name, keyword)
		}
	}
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
