package install

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// wrapperCmd is the shell command that invokes the auto-download wrapper script.
// Hooks and MCP use this instead of a bare "claude-buddy" binary.
const wrapperCmd = `/bin/sh "$HOME/.claude/plugins/claude-buddy/bin/run.sh"`

// Bundle generates the plugin directory structure from Go source definitions.
// The outputDir will contain .claude-plugin/, hooks/, bin/, skills/, agents/, and .mcp.json.
func Bundle(outputDir, version string) error {
	// 1. Create directory structure.
	dirs := []string{
		filepath.Join(outputDir, ".claude-plugin"),
		filepath.Join(outputDir, "hooks"),
		filepath.Join(outputDir, "bin"),
		filepath.Join(outputDir, "agents"),
	}
	for _, skill := range buddySkills {
		dirs = append(dirs, filepath.Join(outputDir, "skills", skill.Dir))
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", d, err)
		}
	}

	// 2. Write plugin.json.
	pluginJSON := map[string]any{
		"name":        "claude-buddy",
		"version":     version,
		"description": "Proactive session advisor for Claude Code",
		"author":      map[string]string{"name": "hir4ta"},
		"homepage":    "https://github.com/hir4ta/claude-buddy",
		"repository":  "https://github.com/hir4ta/claude-buddy",
		"license":     "MIT",
		"keywords":    []string{"session-advisor", "anti-pattern", "workflow", "productivity"},
	}
	if err := writeJSON(filepath.Join(outputDir, ".claude-plugin", "plugin.json"), pluginJSON); err != nil {
		return fmt.Errorf("write plugin.json: %w", err)
	}

	// 3. Write hooks.json — commands invoke the wrapper script.
	hooksJSON := map[string]any{
		"hooks": buddyHookEntries(wrapperCmd),
	}
	if err := writeJSON(filepath.Join(outputDir, "hooks", "hooks.json"), hooksJSON); err != nil {
		return fmt.Errorf("write hooks.json: %w", err)
	}

	// 4. Write .mcp.json — MCP server also uses the wrapper.
	mcpJSON := map[string]any{
		"mcpServers": map[string]any{
			"claude-buddy": map[string]any{
				"command": "/bin/sh",
				"args":    []string{"-c", `"$HOME/.claude/plugins/claude-buddy/bin/run.sh" serve`},
			},
		},
	}
	if err := writeJSON(filepath.Join(outputDir, ".mcp.json"), mcpJSON); err != nil {
		return fmt.Errorf("write .mcp.json: %w", err)
	}

	// 5. Write bin/run.sh — auto-download wrapper.
	runScript := generateRunScript(version)
	runPath := filepath.Join(outputDir, "bin", "run.sh")
	if err := os.WriteFile(runPath, []byte(runScript), 0o755); err != nil {
		return fmt.Errorf("write run.sh: %w", err)
	}

	// 6. Write skills.
	for _, skill := range buddySkills {
		p := filepath.Join(outputDir, "skills", skill.Dir, "SKILL.md")
		if err := os.WriteFile(p, []byte(skill.Content), 0o644); err != nil {
			return fmt.Errorf("write skill %s: %w", skill.Dir, err)
		}
	}

	// 7. Write agent.
	agentPath := filepath.Join(outputDir, "agents", "buddy.md")
	if err := os.WriteFile(agentPath, []byte(buddyAgentContent), 0o644); err != nil {
		return fmt.Errorf("write buddy agent: %w", err)
	}

	hookCount := len(buddyHookEntries(wrapperCmd))

	fmt.Printf("✓ Plugin bundle generated at %s\n", outputDir)
	fmt.Printf("  - plugin.json (v%s)\n", version)
	fmt.Printf("  - hooks.json (%d events)\n", hookCount)
	fmt.Printf("  - .mcp.json\n")
	fmt.Printf("  - bin/run.sh (auto-download wrapper)\n")
	fmt.Printf("  - %d skills\n", len(buddySkills))
	fmt.Printf("  - 1 agent (buddy)\n")
	return nil
}

// generateRunScript creates the wrapper shell script that auto-downloads the binary
// from GitHub Releases on first run or version mismatch.
func generateRunScript(version string) string {
	return `#!/bin/sh
set -e

BUDDY_VERSION="` + version + `"
BUDDY_DIR="${HOME}/.claude-buddy"
BUDDY_BIN="${BUDDY_DIR}/bin/claude-buddy"

# Download binary if missing or version mismatch.
if [ ! -f "$BUDDY_BIN" ] || [ "$("$BUDDY_BIN" version 2>/dev/null)" != "claude-buddy ${BUDDY_VERSION}" ]; then
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
  esac
  URL="https://github.com/hir4ta/claude-buddy/releases/download/v${BUDDY_VERSION}/claude-buddy_${OS}_${ARCH}.tar.gz"
  mkdir -p "${BUDDY_DIR}/bin"
  curl -fsSL "$URL" | tar -xz -C "${BUDDY_DIR}/bin" claude-buddy
  chmod +x "$BUDDY_BIN"
fi

exec "$BUDDY_BIN" "$@"
`
}

func writeJSON(path string, data any) error {
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(out, '\n'), 0o644)
}
