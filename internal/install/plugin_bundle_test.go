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

	// Verify hooks.json has only SessionStart.
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

		for _, event := range []string{"SessionStart", "PreToolUse", "UserPromptSubmit"} {
			if _, ok := hooks[event]; !ok {
				t.Errorf("missing event: %s", event)
			}
		}
		if len(hooks) != 3 {
			t.Errorf("expected 3 hook events, got %d", len(hooks))
		}

		// Verify PreToolUse has correct matcher.
		if preToolUse, ok := hooks["PreToolUse"].([]any); ok && len(preToolUse) > 0 {
			if entry, ok := preToolUse[0].(map[string]any); ok {
				if matcher, _ := entry["matcher"].(string); matcher != "Read|Glob|Grep|Edit|Write" {
					t.Errorf("PreToolUse matcher = %q, want %q", matcher, "Read|Glob|Grep|Edit|Write")
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
