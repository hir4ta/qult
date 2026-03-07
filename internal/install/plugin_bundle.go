package install

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// runCmd is the shell command that invokes the wrapper script.
// ${CLAUDE_PLUGIN_ROOT} is expanded by Claude Code at plugin install time.
const runCmd = `"${CLAUDE_PLUGIN_ROOT}/bin/run.sh"`

// alfredHookEntries returns the hook configuration for plugin distribution.
// SessionStart: CLAUDE.md auto-import.
// PreToolUse: .claude/ config access reminder.
// UserPromptSubmit: Claude Code config keyword detection.
func alfredHookEntries(binPath string) map[string]any {
	return map[string]any{
		"SessionStart": []any{
			map[string]any{
				"hooks": []any{
					map[string]any{
						"type":    "command",
						"command": binPath + " hook SessionStart",
						"timeout": 5,
					},
				},
			},
		},
		"PreCompact": []any{
			map[string]any{
				"hooks": []any{
					map[string]any{
						"type":    "command",
						"command": binPath + " hook PreCompact",
						"timeout": 10,
					},
				},
			},
		},
		"PreToolUse": []any{
			map[string]any{
				"matcher": "Read|Glob|Grep|Edit|Write",
				"hooks": []any{
					map[string]any{
						"type":    "command",
						"command": binPath + " hook PreToolUse",
						"timeout": 3,
					},
				},
			},
		},
		// UserPromptSubmit: LLM gate + knowledge injection.
		// The prompt hook gates the command hook: only clearly unrelated messages are blocked.
		// Default is ok=true (permissive) to avoid false-positive blocking.
		"UserPromptSubmit": []any{
			map[string]any{
				"hooks": []any{
					map[string]any{
						"type":          "prompt",
						"prompt":        "Does this user message relate to Claude Code or software development?\n\nUser message: $ARGUMENTS\n\nRespond ok=true by default. Only respond ok=false if the message is CLEARLY unrelated to software development (e.g., casual chat about weather, cooking, sports). Messages about code, debugging, hooks, errors, configuration, tools, features, or ANY development task should be ok=true.",
						"timeout":       5,
						"statusMessage": "alfred: checking relevance...",
					},
					map[string]any{
						"type":    "command",
						"command": binPath + " hook UserPromptSubmit",
						"timeout": 3,
					},
				},
			},
		},
	}
}

// Bundle generates the plugin directory structure from Go source definitions.
// The outputDir will contain .claude-plugin/, hooks/, bin/, skills/, agents/, rules/, and .mcp.json.
func Bundle(outputDir, version string) error {
	// 0. Clean up deprecated skill directories and rule files.
	for _, dir := range deprecatedSkillDirs {
		_ = os.RemoveAll(filepath.Join(outputDir, "skills", dir))
	}
	for _, file := range deprecatedRuleFiles {
		_ = os.Remove(filepath.Join(outputDir, "rules", file))
	}

	// 1. Create directory structure.
	dirs := []string{
		filepath.Join(outputDir, ".claude-plugin"),
		filepath.Join(outputDir, "hooks"),
		filepath.Join(outputDir, "bin"),
		filepath.Join(outputDir, "agents"),
		filepath.Join(outputDir, "rules"),
	}
	for _, skill := range loadSkills() {
		dirs = append(dirs, filepath.Join(outputDir, "skills", skill.Dir))
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", d, err)
		}
	}

	// 2. Write plugin.json.
	pluginJSON := map[string]any{
		"name":        "alfred",
		"version":     version,
		"description": "Your proactive butler for Claude Code",
		"author":      map[string]string{"name": "hir4ta"},
		"homepage":    "https://github.com/hir4ta/claude-alfred",
		"repository":  "https://github.com/hir4ta/claude-alfred",
		"license":     "MIT",
		"keywords":    []string{"butler", "best-practices", "workflow"},
	}
	if err := writeJSON(filepath.Join(outputDir, ".claude-plugin", "plugin.json"), pluginJSON); err != nil {
		return fmt.Errorf("write plugin.json: %w", err)
	}

	// 3. Write hooks.json — commands invoke the guard/setup wrapper.
	hooksJSON := map[string]any{
		"description": "Proactive butler hooks — auto-import, config access reminder, knowledge injection, spec session persistence",
		"hooks":       alfredHookEntries(runCmd),
	}
	if err := writeJSON(filepath.Join(outputDir, "hooks", "hooks.json"), hooksJSON); err != nil {
		return fmt.Errorf("write hooks.json: %w", err)
	}

	// 4. Write .mcp.json — MCP server also uses the wrapper.
	mcpJSON := map[string]any{
		"mcpServers": map[string]any{
			"alfred": map[string]any{
				"command": "${CLAUDE_PLUGIN_ROOT}/bin/run.sh",
				"args":    []string{"serve"},
			},
		},
	}
	if err := writeJSON(filepath.Join(outputDir, ".mcp.json"), mcpJSON); err != nil {
		return fmt.Errorf("write .mcp.json: %w", err)
	}

	// 5. Write bin/run.sh — guard + setup wrapper.
	runScript := generateRunScript(version)
	runPath := filepath.Join(outputDir, "bin", "run.sh")
	if err := os.WriteFile(runPath, []byte(runScript), 0o755); err != nil {
		return fmt.Errorf("write run.sh: %w", err)
	}

	// 6. Write skills (SKILL.md + supporting files).
	for _, skill := range loadSkills() {
		p := filepath.Join(outputDir, "skills", skill.Dir, "SKILL.md")
		if err := os.WriteFile(p, []byte(skill.Content), 0o644); err != nil {
			return fmt.Errorf("write skill %s: %w", skill.Dir, err)
		}
	}
	for _, sf := range loadSkillSupportFiles() {
		p := filepath.Join(outputDir, "skills", sf.Dir, sf.File)
		if err := os.WriteFile(p, []byte(sf.Data), 0o644); err != nil {
			return fmt.Errorf("write skill support file %s/%s: %w", sf.Dir, sf.File, err)
		}
	}

	// 7. Write agents.
	agents := map[string]string{
		"alfred.md": alfredAgentContent,
	}
	for name, content := range agents {
		p := filepath.Join(outputDir, "agents", name)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			return fmt.Errorf("write agent %s: %w", name, err)
		}
	}

	// 8. Write rules.
	for _, rule := range loadRules() {
		p := filepath.Join(outputDir, "rules", rule.File)
		if err := os.WriteFile(p, []byte(rule.Content), 0o644); err != nil {
			return fmt.Errorf("write rule %s: %w", rule.File, err)
		}
	}

	hookCount := len(alfredHookEntries(runCmd))

	fmt.Printf("✓ Plugin bundle generated at %s\n", outputDir)
	fmt.Printf("  - plugin.json (v%s)\n", version)
	fmt.Printf("  - hooks.json (%d events)\n", hookCount)
	fmt.Printf("  - .mcp.json\n")
	fmt.Printf("  - bin/run.sh (bootstrapper)\n")
	fmt.Printf("  - %d skills\n", len(loadSkills()))
	fmt.Printf("  - %d rules\n", len(loadRules()))
	fmt.Printf("  - %d agents\n", len(agents))
	return nil
}

// generateRunScript creates a bootstrapper script that resolves the alfred binary
// from PATH (Homebrew/go install), local cache, or GitHub Releases download.
func generateRunScript(ver string) string {
	return fmt.Sprintf(`#!/bin/sh
# alfred bootstrapper — resolves binary from PATH, cache, or GitHub Releases.
set -e

REPO="hir4ta/claude-alfred"
VERSION="%s"
CACHE_DIR="${HOME}/.alfred/bin"
CACHED_BIN="${CACHE_DIR}/alfred"

# 1. Binary in PATH? (e.g. Homebrew, go install)
if command -v alfred >/dev/null 2>&1; then
  exec alfred "$@"
fi

# 2. Cached binary exists and matches version?
if [ -x "$CACHED_BIN" ]; then
  CACHED_VER=$("$CACHED_BIN" version --short 2>/dev/null || echo "")
  if [ "$CACHED_VER" = "$VERSION" ]; then
    exec "$CACHED_BIN" "$@"
  fi
fi

# 3. Download from GitHub Releases.
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)        ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac

URL="https://github.com/${REPO}/releases/download/v${VERSION}/alfred_${OS}_${ARCH}.tar.gz"
mkdir -p "$CACHE_DIR"

if command -v curl >/dev/null 2>&1; then
  curl -sSfL "$URL" | tar xz -C "$CACHE_DIR" alfred
elif command -v wget >/dev/null 2>&1; then
  wget -qO- "$URL" | tar xz -C "$CACHE_DIR" alfred
else
  echo "alfred: curl or wget required to download binary" >&2
  echo "  Install via Homebrew instead: brew install hir4ta/alfred/alfred" >&2
  exit 1
fi

chmod +x "$CACHED_BIN"
exec "$CACHED_BIN" "$@"
`, ver)
}

func writeJSON(path string, data any) error {
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(out, '\n'), 0o644)
}
