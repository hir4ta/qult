# claude-buddy

A proactive session companion for Claude Code — real-time anti-pattern detection, predictive health monitoring, causal failure diagnosis, automatic context recovery, AST-based code quality analysis with auto-fix, coverage-aware test correlation, adaptive personalization, and cross-project knowledge sharing. Works as a Claude Code plugin with hooks, MCP tools, skills, and agents.

## Install

```bash
brew install hir4ta/tap/claude-buddy
```

Or build from source:

```bash
git clone https://github.com/hir4ta/claude-buddy
cd claude-buddy
go build -o claude-buddy .
```

## Setup

### 1. Install the plugin (inside Claude Code)

```
/plugin marketplace add hir4ta/claude-buddy
/plugin install claude-buddy@claude-buddy
```

This registers hooks, MCP server, skills, and the buddy agent via the plugin system. Skills are available as `/claude-buddy:buddy-*` commands.

### 2. Sync sessions and embeddings

```bash
claude-buddy install
```

When the plugin is active, this only syncs sessions to the local SQLite database (`~/.claude-buddy/buddy.db`) and generates embeddings. Hook/skill/agent registration is skipped (managed by the plugin).

### 3. Optional: Ollama for semantic search

[Ollama](https://ollama.com) powers vector-based knowledge search across sessions. Without it, search falls back to FTS5 BM25 / LIKE.

```bash
brew install ollama
ollama serve &

# Pull embedding model (choose one)
ollama pull kun432/cl-nagoya-ruri-large    # Japanese
ollama pull nomic-embed-text               # English / other languages
```

## Upgrade

```bash
# 1. Update the binary
brew update && brew upgrade claude-buddy

# 2. Re-sync sessions and embeddings
claude-buddy install
```

Then update the plugin inside Claude Code:

```
/plugin marketplace update
```

Both steps are needed — `brew upgrade` updates the binary (hook handler, MCP server), while `/plugin marketplace update` updates the plugin configuration (hooks, skills, agents).

## Language

claude-buddy detects your system locale (`LANG` / `LC_ALL` / `LC_MESSAGES`) and generates AI feedback in your language. UI labels remain in English.

To persist your language setting, add to your `~/.zshrc` (or `~/.bashrc`):

```bash
export LANG=ja_JP.UTF-8
```

Or set per-invocation:

```bash
LANG=ja_JP.UTF-8 claude-buddy
LANG=ko_KR.UTF-8 claude-buddy
```

> **Note**: On macOS, the terminal may default to `en_US.UTF-8` even if the system language is set to Japanese. Set `LANG` explicitly if feedback appears in the wrong language.

Supported languages: English, Japanese, Chinese, Korean, Spanish, French, German, Portuguese, Russian, Italian, Arabic, Hindi, Thai, Vietnamese, Turkish, Polish, Dutch, Swedish.

## Commands

### `claude-buddy` / `claude-buddy watch`

Monitor a Claude Code session in real-time. Run in a separate terminal or tmux pane.

```bash
# Terminal 1
claude-buddy

# Terminal 2
claude
```

**Features:**

- **Header**: Session ID, turn count, tool usage, elapsed time, pulsing activity indicator
- **Anti-pattern detection**: Real-time alerts for retry loops, context thrashing, excessive tools, destructive commands, and more
  - Warning (yellow) and Action (red) level alert bars
- **Task progress**: TaskCreate/TaskUpdate tracking with shimmer animation
  - `○` pending / `▶` in_progress (animated) / `✔` completed
- **Message stream**: Live display of user input, assistant responses, tool summaries
  - `[user]` / `[answer]` / `[assistant]` / `[task+]` / `[agent]` / `[plan]` / `[msg]`
  - Expand any message with Enter to view full content
- **AI Feedback**: Every turn, LLM evaluates your session against official best practices
  - Situation / Observation / Suggestion with severity levels (info, insight, warning, action)

**Key bindings:**

| Key | Action |
|-----|--------|
| `q` / `Ctrl+C` | Quit |
| `↑` / `k` | Scroll up |
| `↓` / `j` | Scroll down |
| `Enter` | Expand/collapse message |
| `g` / `G` | Jump to top/bottom |
| `?` | Help overlay |

---

### `claude-buddy browse`

Browse past session history with the same expand/collapse interface.

```bash
claude-buddy browse
```

---

### `claude-buddy install`

Sync sessions to the local database and generate embeddings. When the plugin is active, hook/skill/agent registration is automatically skipped and any legacy `~/.claude/` files are cleaned up.

```bash
claude-buddy install
```

---

### `claude-buddy serve`

Run as an MCP server (stdio) for Claude Code integration.

```bash
claude-buddy serve
```

**MCP Tools:**

| Tool | Description |
|------|-------------|
| `buddy_stats` | Session statistics (turns, tool frequency, duration) |
| `buddy_suggest` | Structured recommendations with session health, alerts, and feature utilization |
| `buddy_current_state` | Real-time session snapshot (stats, burst state, health score, predictions) |
| `buddy_sessions` | List recent sessions with metadata |
| `buddy_resume` | Restore previous session context (goal, intent, compaction history, files changed/referenced, decisions) |
| `buddy_recall` | Search across past session history |
| `buddy_alerts` | Real-time anti-pattern detection (retry loops, context thrashing, etc.) |
| `buddy_decisions` | Extract design decisions from past sessions |
| `buddy_patterns` | Cross-project knowledge search with vector semantic search (Ollama) |
| `buddy_estimate` | Task complexity estimation based on historical workflow data |
| `buddy_next_step` | Recommended next actions based on session context and recent tool history |
| `buddy_feedback` | Explicit feedback channel for suggestion effectiveness (helpful/not_helpful/misleading) |
| `buddy_skill_context` | Aggregated session context tailored for a specific skill |
| `buddy_cross_project` | Cross-project pattern search from global knowledge base |

---

### `claude-buddy analyze [session_id]`

AI-powered session analysis via `claude -p`.

```bash
claude-buddy analyze          # Latest session
claude-buddy analyze de999fa4 # Specific session by ID prefix
```

Requires `claude` CLI in PATH.

### `claude-buddy uninstall`

Remove hooks and MCP server registration:

```bash
claude-buddy uninstall
```

### `claude-buddy plugin-bundle [output_dir]`

Generate the plugin directory from Go source definitions. Used for development and CI verification.

```bash
claude-buddy plugin-bundle ./plugin
```

## Plugin

claude-buddy is distributed as a Claude Code plugin. The plugin provides:

- **14 hooks**: SessionStart, PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, PreCompact, SessionEnd, Stop (command + prompt), SubagentStart, SubagentStop, Notification, TeammateIdle, TaskCompleted, PermissionRequest
- **10 skills**: buddy-unstuck, buddy-checkpoint, buddy-before-commit, buddy-impact, buddy-review, buddy-estimate, buddy-error-recovery, buddy-context-recovery, buddy-test-guidance, buddy-predict
- **1 agent**: buddy (persistent memory, session advisor)
- **MCP server**: 14 tools for session analysis, feedback, and cross-project knowledge search

### Skills

| Skill | Invocation | Description |
|---|---|---|
| buddy-unstuck | auto | Escape retry loops and suggest alternative approaches |
| buddy-checkpoint | auto | Session health check with active anti-pattern summary |
| buddy-before-commit | auto | Pre-commit quality verification |
| buddy-impact | `/claude-buddy:buddy-impact` | Blast radius analysis for planned file changes |
| buddy-review | `/claude-buddy:buddy-review` | Review recent changes against pattern DB knowledge |
| buddy-estimate | `/claude-buddy:buddy-estimate` | Task complexity estimation from historical data |
| buddy-predict | `/claude-buddy:buddy-predict` | Prediction dashboard (next tool, cascade risk, health trend) |
| buddy-error-recovery | auto | Past resolution diffs for tool failures |
| buddy-context-recovery | auto | Restore working context after compaction |
| buddy-test-guidance | auto | Test failure debugging strategies |

## Hooks

Hooks actively monitor your session through Claude Code's lifecycle events:

| Hook Event | Behavior |
|---|---|
| **SessionStart** | Auto-restores session context (working set, decisions, git branch), captures git state |
| **PreToolUse** | Blocks destructive commands; episode early-warning (retry cascade, explore stuck, etc.); velocity wall look-ahead; auto-applies high-confidence code fixes; warns on stale reads, git-dirty files, past failures; surfaces related decisions with resolution diffs |
| **PostToolUse** | Tracks tool/file patterns, code quality heuristics, coverage-aware test failure correlation, suggestion effectiveness with pending verification |
| **UserPromptSubmit** | Classifies intent/task type, injects relevant past knowledge, delivers queued nudges |
| **PreCompact** | Serializes working set (files, intent, decisions, git branch) for automatic restoration |
| **Stop** | Detects incomplete work (TODO/FIXME, unresolved failures), warns about uncommitted git changes |
| **PostToolUseFailure** | Causal WHY explanations for failures, deterministic Go compile error patterns, tracks failure cascades, searches past solutions, starts resolution chains, false-positive detection for nudge resolution |
| **SubagentStart** | Injects session context into subagent launches |
| **SubagentStop** | Records subagent outcomes and delivery context |
| **SessionEnd** | Persists user profile, co-change data, workflow sequences; cleans up session state |

**Anti-pattern detectors** (hook-based, real-time):

- **RetryLoop**: 3+ consecutive identical tool calls
- **ExcessiveTools**: 25+ tool calls without user input
- **FileReadLoop**: Same file read 5+ times with no edits
- **ExploreLoop**: 10+ tools, no writes, 5+ minutes elapsed
- **Destructive commands**: `rm -rf`, `git push --force`, `git reset --hard`, `git checkout -- .`, `chmod 777`, etc.

**Proactive advisor signals** (context-injected via `additionalContext`):

- **Episode early-warning**: Detects emerging anti-patterns (retry cascade, explore stuck, edit-fail spiral, test-fixup fail, context overload) *before* tool execution, not after
- **Velocity wall look-ahead**: Predicts health decline using EWMV variance gating + OLS trend regression, warns ~30 tool calls before threshold breach
- **Auto-apply code fixes**: High-confidence (>=0.9) AST-based patches auto-applied on Edit for Go files (nil-error-wrap, defer-in-loop). Revert tracking for dynamic confidence adjustment
- **Causal WHY explanations**: Every failure diagnostic includes a WHY line explaining the root cause with causal links to recently edited files
- **Deterministic compile error patterns**: 9 Go-specific regex patterns (undefined, type mismatch, unused import, missing return, etc.) checked before LLM fallback (<1ms)
- **Stale read warning**: File not re-read before editing, or last Read was 8+ tool calls ago
- **Past failure warning**: Similar Bash command failed earlier in the session, with resolution diff display showing previous `old→new` fixes
- **Git dirty file warning**: Editing a file with pre-existing uncommitted changes
- **Code quality analysis**: Go via `go/ast`, Python/JS/TS/Rust via tree-sitter AST — detects unchecked errors, debug prints, bare excepts, mutable defaults, loose equality, hardcoded secrets, TODO without ticket numbers, and more. Includes concrete fix patch generation via CodeFixer
- **Test coverage mapping**: AST-based function→test mapping generates specific `go test -run TestName ./pkg/` suggestions instead of generic "run tests". Coverage map used for causal test failure correlation
- **Test failure correlation**: Connects test failures to recently edited files via coverage map (function-level precision) with fallback to file-list heuristics
- **Workflow guidance**: Learned playbooks from past sessions with concrete file names and test commands; suggests test-first approach for bugfix/refactor tasks
- **Past knowledge surfacing**: Surfaces related decisions, error solutions, and resolution chains (tool sequences) from previous sessions
- **Cross-project learning**: Patterns and decisions are synced to a global DB (`~/.claude-buddy/global.db`) for reuse across projects

**Automatic context recovery** (survives compaction):

Working set (currently edited files, intent, task type, key decisions, git branch) is automatically serialized before compaction and restored afterward. No manual intervention required.

**Suggestion effectiveness tracking**:

Nudge delivery and resolution are tracked across sessions with two-step pending verification (mark pending on resolution action → confirm on next tool success/failure) to reduce false positives. Implicit negative signals are recorded when 4+ tools elapse without resolution. Patterns delivered 20+ times with <10% resolution rate are automatically suppressed. Auto-feedback is skipped when it contradicts explicit user feedback. Explicit feedback via `buddy_feedback` MCP tool is integrated into Thompson Sampling with KL regularization for priority adjustment.

**Deep intent model**:

4-layer understanding of the user's task: TaskType (bugfix/feature/refactor/test/explore/debug/review/docs), Domain (auth/database/ui/api/config/infra), WorkflowPhase (explore/design/implement/test/integrate), and RiskProfile (conservative/balanced/aggressive). Used for phase-aware suggestion gating and personalized advice.

**User profiling and personalization**:

Behavioral clustering (conservative/balanced/aggressive) based on read-write ratio, test frequency, and session velocity. Profile influences anti-pattern detection thresholds (conservative: 0.7x for earlier warnings, aggressive: 1.5x for higher tolerance), suggestion priority, and delivery timing via phase-aware gating.

## Architecture

```
claude-buddy/
├── main.go                    # Entry point + subcommand routing
├── plugin/                    # Claude Code plugin (generated by plugin-bundle)
│   ├── .claude-plugin/        # Plugin manifest
│   ├── hooks/                 # Hook definitions (14 events)
│   ├── skills/                # 10 buddy skills
│   ├── agents/                # Buddy agent
│   └── .mcp.json              # MCP server config
├── .claude-plugin/            # Marketplace manifest
├── internal/
│   ├── parser/                # JSONL parser (type definitions + parsing)
│   ├── watcher/               # File watching (fsnotify + tail)
│   ├── analyzer/              # Live stats + Feedback type + anti-pattern detector
│   ├── coach/                 # AI feedback generation via claude -p
│   ├── hookhandler/           # Hook handlers (advisor signals, code heuristics, test correlation)
│   ├── sessiondb/             # Ephemeral per-session SQLite (working set, burst state, nudges)
│   ├── embedder/              # Ollama integration for semantic search
│   ├── locale/                # System locale detection (18 languages)
│   ├── tui/                   # Bubble Tea TUI (watch / browse / select)
│   ├── mcpserver/             # MCP server (stdio, 14 tools)
│   ├── store/                 # SQLite persistence (vector search + LIKE search + incremental sync + global DB)
│   └── install/               # Plugin bundle + hook registration + initial sync
├── go.mod
└── go.sum
```

## Dependencies

| Library | Purpose |
|---------|---------|
| [charmbracelet/bubbletea](https://github.com/charmbracelet/bubbletea) | TUI framework |
| [charmbracelet/lipgloss](https://github.com/charmbracelet/lipgloss) | TUI styling |
| [fsnotify/fsnotify](https://github.com/fsnotify/fsnotify) | File change watching |
| [mark3labs/mcp-go](https://github.com/mark3labs/mcp-go) | MCP server SDK |
| [ncruces/go-sqlite3](https://github.com/ncruces/go-sqlite3) | SQLite driver (pure Go, WASM-based) |
| [odvcencio/gotreesitter](https://github.com/odvcencio/gotreesitter) | Pure Go tree-sitter runtime for multi-language AST analysis |

## Ollama

Ollama powers `buddy_patterns` and hook-based knowledge injection via vector semantic search. The embedding model is auto-selected based on your system locale: `kun432/cl-nagoya-ruri-large` (1024d) for Japanese, `nomic-embed-text` (768d) for other languages.

Ollama availability is checked once at session start and cached — subsequent hook calls use a single HTTP round-trip for embedding.

Without Ollama, knowledge search falls back to FTS5 BM25 / LIKE — all features work, just without semantic matching. FTS5 uses phrase-first search for multi-word queries (higher precision), falling back to OR-based search, with title-match reordering for relevance.
