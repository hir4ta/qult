package install

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// runCmd is the shell command that invokes the guard/setup wrapper script.
// ${CLAUDE_PLUGIN_ROOT} is expanded by Claude Code at plugin install time.
const runCmd = `"${CLAUDE_PLUGIN_ROOT}/bin/run.sh"`

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

	// 3. Write hooks.json — commands invoke the guard/setup wrapper.
	hooksJSON := map[string]any{
		"hooks": buddyHookEntries(runCmd),
	}
	if err := writeJSON(filepath.Join(outputDir, "hooks", "hooks.json"), hooksJSON); err != nil {
		return fmt.Errorf("write hooks.json: %w", err)
	}

	// 4. Write .mcp.json — MCP server also uses the wrapper.
	mcpJSON := map[string]any{
		"mcpServers": map[string]any{
			"claude-buddy": map[string]any{
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

	hookCount := len(buddyHookEntries(runCmd))

	fmt.Printf("✓ Plugin bundle generated at %s\n", outputDir)
	fmt.Printf("  - plugin.json (v%s)\n", version)
	fmt.Printf("  - hooks.json (%d events)\n", hookCount)
	fmt.Printf("  - .mcp.json\n")
	fmt.Printf("  - bin/run.sh (guard + setup wrapper)\n")
	fmt.Printf("  - %d skills\n", len(buddySkills))
	fmt.Printf("  - 1 agent (buddy)\n")
	return nil
}

// generateRunScript creates the auto-download wrapper script (Gradle Wrapper pattern).
// On every invocation it checks whether the binary exists and matches the expected
// version. If not, it downloads the binary from GitHub Releases automatically.
// The "setup" subcommand is kept for explicit first-time initialization (DB sync +
// embedding generation). Regular updates via /plugin only need the auto-download path.
func generateRunScript(version string) string {
	return `#!/bin/sh
# claude-buddy wrapper — auto-downloads binary on version mismatch.
BUDDY_VERSION="` + version + `"
BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
BUDDY_BIN="${BIN_DIR}/claude-buddy"
VERSION_FILE="${BIN_DIR}/.buddy-version"
LOCK_DIR="${BIN_DIR}/.buddy-download.lock"
INSTALL_MARKER="${BIN_DIR}/.buddy-installed-${BUDDY_VERSION}"

# --- helpers ----------------------------------------------------------------

is_current() {
  [ -f "$BUDDY_BIN" ] && [ -f "$VERSION_FILE" ] && \
    [ "$(cat "$VERSION_FILE" 2>/dev/null)" = "$BUDDY_VERSION" ]
}

detect_platform() {
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
  esac
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "${LOCK_DIR}/pid"
    return 0
  fi
  # Check for stale lock (owner process dead).
  if [ -f "${LOCK_DIR}/pid" ]; then
    LOCK_PID=$(cat "${LOCK_DIR}/pid" 2>/dev/null)
    if [ -n "$LOCK_PID" ] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
      rm -rf "$LOCK_DIR"
      if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo $$ > "${LOCK_DIR}/pid"
        return 0
      fi
    fi
  fi
  return 1
}

release_lock() { rm -rf "$LOCK_DIR"; }

download_binary() {
  detect_platform
  URL="https://github.com/hir4ta/claude-buddy/releases/download/v${BUDDY_VERSION}/claude-buddy_${OS}_${ARCH}.tar.gz"
  TMP_TAR="${BIN_DIR}/.buddy-dl.$$.tar.gz"
  TMP_EXTRACT="${BIN_DIR}/.buddy-dl.$$"

  # Download tarball.
  if ! curl -fsSL --retry 2 --max-time 60 "$URL" -o "$TMP_TAR" 2>/dev/null; then
    rm -f "$TMP_TAR"
    return 1
  fi

  # Extract to temp dir, then move atomically.
  mkdir -p "$TMP_EXTRACT"
  if ! tar -xzf "$TMP_TAR" -C "$TMP_EXTRACT" claude-buddy 2>/dev/null; then
    rm -f "$TMP_TAR"; rm -rf "$TMP_EXTRACT"
    return 1
  fi
  chmod +x "${TMP_EXTRACT}/claude-buddy"
  mv -f "${TMP_EXTRACT}/claude-buddy" "$BUDDY_BIN"
  printf '%s' "$BUDDY_VERSION" > "$VERSION_FILE"
  rm -f "$TMP_TAR"; rm -rf "$TMP_EXTRACT"
  return 0
}

# Try to ensure binary is current.  Returns 0 if binary is usable.
ensure_binary() {
  is_current && return 0

  if acquire_lock; then
    download_binary
    DL_RC=$?
    release_lock
    [ $DL_RC -eq 0 ] && return 0
  else
    # Another process is downloading — wait briefly.
    WAIT=0
    while [ $WAIT -lt "$1" ]; do
      sleep 1
      is_current && return 0
      WAIT=$((WAIT + 1))
    done
  fi

  # Fallback: use old binary if it exists (version mismatch but functional).
  [ -f "$BUDDY_BIN" ] && return 0
  return 1
}

# --- main dispatch ----------------------------------------------------------

case "$1" in
  setup)
    # Explicit first-time setup (called from curl one-liner or /claude-buddy:init).
    if is_current; then
      echo "claude-buddy ${BUDDY_VERSION} already installed"
    else
      if acquire_lock; then
        download_binary || { release_lock; echo "Download failed." >&2; exit 1; }
        release_lock
      else
        echo "Another download in progress. Waiting..." >&2
        WAIT=0
        while [ $WAIT -lt 60 ]; do
          sleep 1; is_current && break; WAIT=$((WAIT + 1))
        done
        is_current || { echo "Download timed out." >&2; exit 1; }
      fi
      echo "claude-buddy ${BUDDY_VERSION} installed"
    fi
    shift
    exec "$BUDDY_BIN" install "$@"
    ;;

  count-sessions)
    # Quick session count — no sync, just directory scan.
    if ! ensure_binary 30; then
      echo '{"error":"binary not available"}' >&2
      exit 1
    fi
    exec "$BUDDY_BIN" count-sessions
    ;;

  serve)
    # MCP server — no timeout, block until binary ready.
    if ! ensure_binary 60; then
      echo "claude-buddy: binary not available. Run setup first." >&2
      exit 1
    fi
    # Run install in background on first serve after download.
    if [ ! -f "$INSTALL_MARKER" ]; then
      ( "$BUDDY_BIN" install >/dev/null 2>&1; printf '%s' "$BUDDY_VERSION" > "$INSTALL_MARKER" ) &
    fi
    exec "$BUDDY_BIN" serve
    ;;

  hook-handler)
    # Hooks have tight timeouts (1-8s). Try briefly, then degrade.
    if ! ensure_binary 3; then
      echo '{"additionalContext":"[claude-buddy] Updating binary. Will be ready shortly."}'
      exit 0
    fi
    exec "$BUDDY_BIN" "$@"
    ;;

  version|--version|-v)
    if is_current; then
      exec "$BUDDY_BIN" version
    fi
    echo "claude-buddy ${BUDDY_VERSION} (binary not yet downloaded)"
    ;;

  *)
    if ! ensure_binary 30; then
      echo "claude-buddy: binary not available. Run setup first." >&2
      exit 1
    fi
    exec "$BUDDY_BIN" "$@"
    ;;
esac
`
}

func writeJSON(path string, data any) error {
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(out, '\n'), 0o644)
}
