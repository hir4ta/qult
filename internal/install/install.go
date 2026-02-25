package install

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/hir4ta/claude-buddy/internal/embedder"
	"github.com/hir4ta/claude-buddy/internal/locale"
	"github.com/hir4ta/claude-buddy/internal/store"
)

// Run executes the install command. All steps are idempotent.
func Run() error {
	// Step 1: Generate plugin bundle.
	if err := generatePluginBundle(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: plugin bundle generation failed: %v\n", err)
	}

	// Step 2: MCP registration.
	registerMCP()

	// Step 3: Initial sync.
	if err := initialSync(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: initial sync failed: %v\n", err)
	}

	// Step 4: Generate embeddings (if Ollama available).
	generateEmbeddings()

	// Step 5: Print plugin instructions.
	printPluginInstructions()

	return nil
}

// pluginDirFunc is a package-level variable for test overrides.
var pluginDirFunc = pluginDir

func pluginDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".claude-buddy", "plugin")
}

func generatePluginBundle() error {
	dir := pluginDirFunc()

	dirs := []string{
		filepath.Join(dir, ".claude-plugin"),
		filepath.Join(dir, "hooks"),
		filepath.Join(dir, "skills", "health"),
		filepath.Join(dir, "skills", "review"),
		filepath.Join(dir, "skills", "patterns"),
		filepath.Join(dir, "scripts"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", d, err)
		}
	}

	files := map[string]string{
		filepath.Join(dir, ".claude-plugin", "plugin.json"): pluginJSON,
		filepath.Join(dir, ".mcp.json"):                     mcpJSON,
		filepath.Join(dir, "hooks", "hooks.json"):           hooksJSON,
		filepath.Join(dir, "skills", "health", "SKILL.md"):  skillHealth,
		filepath.Join(dir, "skills", "review", "SKILL.md"):  skillReview,
		filepath.Join(dir, "skills", "patterns", "SKILL.md"): skillPatterns,
		filepath.Join(dir, "scripts", "buddy"):               launcherScript,
	}

	for path, content := range files {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", path, err)
		}
	}

	// Make launcher executable.
	if err := os.Chmod(filepath.Join(dir, "scripts", "buddy"), 0o755); err != nil {
		return fmt.Errorf("chmod launcher: %w", err)
	}

	fmt.Println("✓ Plugin bundle generated")
	return nil
}

func registerMCP() {
	binPath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not determine binary path: %v\n", err)
		return
	}

	cmd := exec.Command("claude", "mcp", "add", "-s", "user", "claude-buddy", "--", binPath, "serve")
	if output, err := cmd.CombinedOutput(); err != nil {
		fmt.Printf("Warning: MCP registration: %v (%s)\n", err, strings.TrimSpace(string(output)))
	} else {
		fmt.Println("✓ MCP server registered")
	}
}

func initialSync() error {
	st, err := store.OpenDefault()
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	if err := st.SyncAllWithProgress(func(done, total int) {
		renderProgress("Syncing sessions", done, total)
	}); err != nil {
		return fmt.Errorf("sync: %w", err)
	}
	clearLine()

	var sessionCount, eventCount, patternCount int
	st.DB().QueryRow("SELECT COUNT(*) FROM sessions").Scan(&sessionCount)
	st.DB().QueryRow("SELECT COUNT(*) FROM events").Scan(&eventCount)
	st.DB().QueryRow("SELECT COUNT(*) FROM patterns").Scan(&patternCount)

	fmt.Printf("✓ Synced %d sessions (%d events, %d patterns)\n", sessionCount, eventCount, patternCount)
	return nil
}

func generateEmbeddings() {
	lang := locale.Detect()
	model := embedder.ModelForLocale(lang.Code)
	emb := embedder.NewEmbedder("", model)

	ctx := context.Background()
	if !emb.EnsureAvailable(ctx) {
		fmt.Println("ℹ Ollama not available — skipping embeddings (FTS5 search only)")
		return
	}

	st, err := store.OpenDefault()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: embedding failed: %v\n", err)
		return
	}
	defer st.Close()

	count, err := st.EmbedPending(func(text string) ([]float32, error) {
		return emb.EmbedForStorage(ctx, text)
	}, model, func(done, total int) {
		renderProgress("Generating embeddings", done, total)
	})
	if err != nil {
		clearLine()
		fmt.Fprintf(os.Stderr, "Warning: embedding failed: %v\n", err)
		return
	}
	clearLine()

	if count > 0 {
		fmt.Printf("✓ Generated %d embeddings (model: %s)\n", count, model)
	} else {
		fmt.Printf("✓ Embeddings up to date (model: %s)\n", model)
	}
}

func printPluginInstructions() {
	dir := pluginDirFunc()
	fmt.Printf(`
✓ Installation complete!

Plugin bundle: %s

To enable the plugin (hooks + skills):
  claude plugin install %s --scope user

Or manually add to ~/.claude/settings.json:
  {
    "plugins": [{"path": "%s"}]
  }

Hooks enabled:
  SessionStart   → Auto-restore previous session context
  PreToolUse     → Block destructive Bash commands
  PostToolUse    → Track anti-patterns in background
  UserPromptSubmit → Inject proactive warnings
  PreCompact     → Detect context thrashing
  SessionEnd     → Cleanup session state
`, dir, dir, dir)
}

func renderProgress(prefix string, done, total int) {
	if total == 0 {
		return
	}
	const barWidth = 25
	filled := min(barWidth*done/total, barWidth)
	bar := strings.Repeat("█", filled) + strings.Repeat("░", barWidth-filled)
	fmt.Printf("\r⏳ %s [%s] %d/%d", prefix, bar, done, total)
}

func clearLine() {
	fmt.Print("\r\033[K")
}

// --- Embedded plugin content ---

const pluginJSON = `{
  "name": "claude-buddy",
  "description": "Proactive session companion — anti-pattern detection, context recovery, and usage coaching",
  "version": "0.4.0",
  "author": {
    "name": "hir4ta"
  },
  "repository": "https://github.com/hir4ta/claude-buddy"
}
`

const mcpJSON = `{
  "mcpServers": {
    "claude-buddy": {
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/buddy",
      "args": ["serve"]
    }
  }
}
`

const hooksJSON = `{
  "description": "claude-buddy proactive session monitoring",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/buddy hook-handler SessionStart",
            "timeout": 5
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/buddy hook-handler PreToolUse",
            "timeout": 2
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/buddy hook-handler PostToolUse",
            "timeout": 3,
            "async": true
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/buddy hook-handler UserPromptSubmit",
            "timeout": 2
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/buddy hook-handler PreCompact",
            "timeout": 3
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/buddy hook-handler SessionEnd",
            "timeout": 5,
            "async": true
          }
        ]
      }
    ]
  }
}
`

const skillHealth = `---
name: health
description: Check session health — detects anti-patterns and shows active alerts with suggestions. Use when you want to assess the current session quality.
---

Check the current session health by calling the ` + "`buddy_alerts`" + ` MCP tool.
Present the results as a clear summary:
1. Health score (0-100%)
2. Active alerts with level, observation, and suggestion
3. If health is below 70%, recommend specific actions
`

const skillReview = `---
name: review
description: End-of-session usage review with stats and improvement tips. Use at the end of a coding session.
---

Generate an end-of-session review:
1. Call ` + "`buddy_stats`" + ` to get session statistics
2. Call ` + "`buddy_tips`" + ` to get AI-powered improvement suggestions
3. Present a concise summary: duration, turns, tool usage, key suggestions, score
`

const skillPatterns = `---
name: patterns
description: Search past error solutions, architecture decisions, and reusable knowledge. Use when facing a problem that may have been solved before.
argument-hint: <search query>
---

Search for relevant patterns from past sessions using ` + "`buddy_patterns`" + ` with query "$ARGUMENTS".
If no arguments provided, ask what topic or problem to search for.
Present results grouped by type (error_solution, architecture, decision).
`

const launcherScript = `#!/bin/bash
set -euo pipefail

BUDDY=""
if command -v claude-buddy &>/dev/null; then
  BUDDY="claude-buddy"
elif [ -x "$HOME/.claude-buddy/bin/claude-buddy" ]; then
  BUDDY="$HOME/.claude-buddy/bin/claude-buddy"
fi

if [ -z "$BUDDY" ]; then
  echo "claude-buddy binary not found" >&2
  exit 1
fi

exec "$BUDDY" "$@"
`
