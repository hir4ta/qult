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
func alfredHookEntries(binPath string) map[string]any {
	// Stop hook prompt for quality gate.
	stopPrompt := `You are a quality gate for a development workflow. Check the conversation transcript ($ARGUMENTS).

FIRST: Determine if code was actually written or modified in this session (look for Edit/Write tool calls that changed source files). If NO code was changed — only analysis, Q&A, discussion, or planning — respond {"ok": true} immediately.

ONLY if significant code was written or modified, check:
1. Was a review done? Look for /alfred:review, self-review discussion, or explicit review.
2. If a spec is active (.alfred/specs/), was session.md updated with current progress?

If all applicable conditions are met, respond: {"ok": true}
If a genuinely important step was skipped, respond: {"ok": false, "reason": "Suggestion: [concise action]"}

IMPORTANT: Respond with ONLY raw JSON. No markdown, no code fences, no explanation.`

	return map[string]any{
		"Stop": []any{
			map[string]any{
				"hooks": []any{
					map[string]any{
						"type":    "prompt",
						"prompt":  stopPrompt,
						"timeout": 30,
					},
				},
			},
		},
		"SessionStart": []any{
			map[string]any{
				"hooks": []any{
					map[string]any{
						"type":          "command",
						"command":       binPath + " hook SessionStart",
						"statusMessage": "alfred: restoring session context...",
						"timeout":       5,
					},
				},
			},
		},
		"PreCompact": []any{
			map[string]any{
				"hooks": []any{
					map[string]any{
						"type":          "command",
						"command":       binPath + " hook PreCompact",
						"statusMessage": "alfred: saving session state...",
						"timeout":       10,
					},
				},
			},
		},
		"UserPromptSubmit": []any{
			map[string]any{
				"hooks": []any{
					map[string]any{
						"type":          "command",
						"command":       binPath + " hook UserPromptSubmit",
						"statusMessage": "alfred: searching knowledge...",
						"timeout":       10,
					},
				},
			},
		},
		// PostToolUse: contextual hints after file edits.
		"PostToolUse": []any{
			map[string]any{
				"matcher": "Edit|Write",
				"hooks": []any{
					map[string]any{
						"type":          "command",
						"command":       binPath + " hook PostToolUse",
						"statusMessage": "alfred: checking changes...",
						"timeout":       5,
					},
				},
			},
		},
		// SessionEnd: session summary + instinct extraction.
		"SessionEnd": []any{
			map[string]any{
				"matcher": "logout|prompt_input_exit|bypass_permissions_disabled|other",
				"hooks": []any{
					map[string]any{
						"type":          "command",
						"command":       binPath + " hook SessionEnd",
						"statusMessage": "alfred: saving session memory...",
						"timeout":       3,
					},
				},
			},
		},
	}
}

// Bundle generates the plugin directory structure from Go source definitions.
// The outputDir will contain .claude-plugin/, hooks/, bin/, skills/, agents/, rules/, and .mcp.json.
func Bundle(outputDir, version string) error {
	// 0. Clean up deprecated skill directories, rule files, and settings.json.
	for _, dir := range deprecatedSkillDirs {
		_ = os.RemoveAll(filepath.Join(outputDir, "skills", dir))
	}
	for _, file := range deprecatedRuleFiles {
		_ = os.Remove(filepath.Join(outputDir, "rules", file))
	}
	// settings.json only supports the "agent" key — setting it would activate
	// the alfred agent as default for all sessions, violating the "silent butler"
	// philosophy (never interrupt unless called). Intentionally omitted.
	_ = os.Remove(filepath.Join(outputDir, "settings.json"))

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
		"description": "Your silent butler for Claude Code — surfacing knowledge, catching scope violations, and preserving session context across compactions.",
		"author":      map[string]string{"name": "hir4ta", "url": "https://github.com/hir4ta"},
		"homepage":    "https://github.com/hir4ta/claude-alfred",
		"repository":  "https://github.com/hir4ta/claude-alfred",
		"license":     "MIT",
		"keywords":    []string{"alfred", "best-practices", "workflow", "compaction", "spec", "documentation"},
	}
	if err := writeJSON(filepath.Join(outputDir, ".claude-plugin", "plugin.json"), pluginJSON); err != nil {
		return fmt.Errorf("write plugin.json: %w", err)
	}

	// 3. Write hooks.json — commands invoke the guard/setup wrapper.
	hooksJSON := map[string]any{
		"description": "Proactive hooks — auto-import, knowledge injection, spec session persistence, memory persistence",
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
				"env": map[string]string{
					"VOYAGE_API_KEY": "${VOYAGE_API_KEY}",
				},
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
		"alfred.md":        alfredAgentContent,
		"code-reviewer.md": codeReviewerAgentContent,
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

# 1. Binary in PATH with matching version? (e.g. Homebrew, go install)
if command -v alfred >/dev/null 2>&1; then
  PATH_VER=$(alfred version --short 2>/dev/null || echo "")
  # Strip build metadata (+dirty, +dev, etc.) for comparison
  PATH_VER_BASE="${PATH_VER%%+*}"
  if [ "$PATH_VER_BASE" = "$VERSION" ] || [ "$PATH_VER" = "dev" ]; then
    exec alfred "$@"
  fi
fi

# 2. Cached binary exists and matches version?
if [ -x "$CACHED_BIN" ]; then
  CACHED_VER=$("$CACHED_BIN" version --short 2>/dev/null || echo "")
  CACHED_VER_BASE="${CACHED_VER%%+*}"
  if [ "$CACHED_VER_BASE" = "$VERSION" ]; then
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
CHECKSUM_URL="https://github.com/${REPO}/releases/download/v${VERSION}/checksums.txt"
mkdir -p "$CACHE_DIR"

DL_DIR=$(mktemp -d)
trap 'rm -rf "$DL_DIR"' EXIT

if command -v curl >/dev/null 2>&1; then
  curl -sSfL "$URL" -o "$DL_DIR/alfred.tar.gz"
  curl -sSfL "$CHECKSUM_URL" -o "$DL_DIR/checksums.txt"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$DL_DIR/alfred.tar.gz" "$URL"
  wget -qO "$DL_DIR/checksums.txt" "$CHECKSUM_URL"
else
  echo "alfred: curl or wget required to download binary" >&2
  echo "  Install via Homebrew instead: brew install hir4ta/alfred/alfred" >&2
  exit 1
fi

# Verify checksum (required for binary integrity).
if command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
else
  echo "alfred: shasum or sha256sum not found — cannot verify binary integrity" >&2
  exit 1
fi
EXPECTED=$(grep "alfred_${OS}_${ARCH}.tar.gz" "$DL_DIR/checksums.txt" | awk '{print $1}')
if [ -z "$EXPECTED" ]; then
  echo "alfred: no checksum found for alfred_${OS}_${ARCH}.tar.gz" >&2
  exit 1
fi
ACTUAL=$($SHA_CMD "$DL_DIR/alfred.tar.gz" | awk '{print $1}')
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "alfred: checksum mismatch (expected ${EXPECTED}, got ${ACTUAL})" >&2
  exit 1
fi

tar -xzf "$DL_DIR/alfred.tar.gz" -C "$CACHE_DIR" alfred
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
