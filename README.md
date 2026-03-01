# claude-alfred

A proactive session companion for Claude Code — real-time session monitoring, knowledge base management, adaptive personalization, and cross-project learning. Works as a Claude Code plugin with hooks, MCP tools, skills, rules, and agents.

## Install

**1. Add the plugin in Claude Code:**

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install claude-alfred@claude-alfred
```

**2. Run initial setup in your terminal (one-time):**

```bash
curl -fsSL https://raw.githubusercontent.com/hir4ta/claude-alfred/main/setup.sh | sh
```

This downloads the binary, syncs all available sessions (JSONL parsing + embedding generation), and creates a `~/.local/bin/claude-alfred` symlink for PATH access.

**3. Restart Claude Code** to activate hooks and MCP tools.

### Optional: Voyage AI for semantic search

Set `VOYAGE_API_KEY` before running setup to enable vector-based knowledge search across sessions. Without it, search falls back to FTS5 BM25 / LIKE.

```bash
export VOYAGE_API_KEY=your-api-key
curl -fsSL https://raw.githubusercontent.com/hir4ta/claude-alfred/main/setup.sh | sh
```

Uses `voyage-4-large` (2048 dimensions) for maximum retrieval accuracy.

### Building from source

```bash
git clone https://github.com/hir4ta/claude-alfred
cd claude-alfred
go build -o claude-alfred .
```

## Upgrade

Update the plugin inside Claude Code:

```
/plugin marketplace update
```

The binary is automatically downloaded on the next Claude Code restart.

## Commands

### `claude-alfred` / `claude-alfred watch`

Monitor a Claude Code session in real-time with a tabbed dashboard. Run in a separate terminal or tmux pane.

```bash
# Terminal 1
claude-alfred

# Terminal 2
claude
```

**Dashboard tabs:**

| Tab | Content |
|-----|---------|
| **1:Activity** | Live event stream — user input, assistant responses, tool summaries, task progress |
| **2:Knowledge** | Knowledge base statistics — total sections, source breakdown, freshness, latest version |
| **3:Preferences** | User profile — cluster classification, EWMA metrics, feature usage |
| **4:Docs** | Interactive documentation search — FTS5/LIKE search with expandable content |

**Key bindings:**

| Key | Action |
|-----|--------|
| `1`-`4` / `Tab` / `Shift+Tab` | Switch tabs |
| `↑` / `k`, `↓` / `j` | Scroll / select |
| `Enter` | Expand/collapse |
| `/` | Search (Docs tab) |
| `g` / `G` | Jump to top/bottom |
| `?` | Help overlay |
| `q` / `Ctrl+C` | Quit |

---

### `claude-alfred browse`

Browse past session history with the same expand/collapse interface.

---

### `claude-alfred serve`

Run as an MCP server (stdio) for Claude Code integration.

**MCP Tools (7 consolidated):**

| Tool | Description |
|------|-------------|
| `state` | Session health, statistics, predictions, session list, context recovery, skill context, accuracy metrics, user preferences (`detail`: brief/standard/outlook/sessions/resume/skill/accuracy/preferences) |
| `knowledge` | Search docs, decisions, cross-project insights, and pre-compact history (`scope`: project/global/recall) |
| `guidance` | Workflow recommendations, alerts, next steps, pending nudges (`focus`: all/alerts/recommendations/next_steps/pending) |
| `plan` | Task estimation, progress tracking, strategic workflow planning (`mode`: estimate/progress/strategy) |
| `diagnose` | Error diagnosis + concrete fix patches with before/after code and verification commands |
| `ingest` | Document ingestion — stores sections with vector embeddings for semantic search |
| `feedback` | Rate suggestion quality (helpful/partially_helpful/not_helpful/misleading) |

All tools support `format=concise` for reduced token consumption.

---

### `claude-alfred install`

Sync sessions and generate embeddings. Creates `~/.local/bin/claude-alfred` symlink for PATH access.

```bash
claude-alfred install                # Default: sync past 30 days
claude-alfred install --since=7d     # 7d, 14d, 30d, or 90d
```

### `claude-alfred analyze [session_id]`

Session analysis report.

```bash
claude-alfred analyze          # Latest session
claude-alfred analyze de999fa4 # Specific session by ID prefix
```

### `claude-alfred uninstall`

Remove hooks and MCP server registration.

### `claude-alfred plugin-bundle [output_dir]`

Generate the plugin directory from Go source definitions.

## Plugin

claude-alfred is distributed as a Claude Code plugin. The plugin provides:

- **13 hooks**: SessionStart, PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, PreCompact, SessionEnd, SubagentStart, SubagentStop, Notification, TeammateIdle, TaskCompleted, PermissionRequest
- **9 skills**: alfred-analyze, alfred-audit, alfred-context-recovery, alfred-crawl, alfred-forecast, alfred-gate, alfred-learn, alfred-recover, alfred-setup
- **7 rules**: claude-md, skills, hooks, agents, mcp-config, rules, memory
- **1 agent**: alfred (session advisor)
- **MCP server**: 7 consolidated tools

### Skills

| Skill | Invocation | Description |
|---|---|---|
| alfred-recover | auto | Failure recovery: stuck loops, error resolution |
| alfred-gate | auto | Session health check + pre-commit quality gate |
| alfred-context-recovery | auto | Restore working context after compaction |
| alfred-analyze | `/claude-alfred:alfred-analyze` | Session analysis and change review |
| alfred-forecast | `/claude-alfred:alfred-forecast` | Task estimation and session prediction |
| alfred-crawl | `/claude-alfred:alfred-crawl` | Crawl and ingest Claude Code documentation |
| alfred-audit | `/claude-alfred:alfred-audit` | Code quality audit |
| alfred-learn | `/claude-alfred:alfred-learn` | Pattern learning from sessions |
| alfred-setup | `/claude-alfred:alfred-setup` | Initial setup wizard |

## Hooks

Hooks monitor sessions through Claude Code's lifecycle events with minimal overhead (sensor-based design):

| Hook Event | Behavior |
|---|---|
| **SessionStart** | Restores session context (working set, decisions, git branch), checks docs freshness |
| **PreToolUse** | Safety checks, stale-read warnings, past failure warnings |
| **PostToolUse** | Tracks tool/file patterns, workflow phases, feature usage, solution chains |
| **UserPromptSubmit** | Classifies intent/task type, delivers brief context signal |
| **PreCompact** | Serializes working set for automatic restoration |
| **PostToolUseFailure** | Failure diagnosis, tracks failure cascades |
| **SessionEnd** | Persists user profile, workflow sequences, feature preferences; syncs to global DB |

**Automatic context recovery**: Working set (files, intent, task type, decisions, git branch) is serialized before compaction and restored afterward.

**User profiling**: Behavioral clustering (conservative/balanced/aggressive) based on read-write ratio, test frequency, and session velocity. Profile influences detection thresholds and suggestion priorities.

**Cross-project learning**: Patterns and decisions synced to global DB (`~/.claude-alfred/global.db`) for reuse across projects.

## Architecture

```
claude-alfred/
├── main.go                    # Entry point + subcommand routing
├── plugin/                    # Claude Code plugin (generated by plugin-bundle)
│   ├── .claude-plugin/        # Plugin manifest
│   ├── hooks/                 # Hook definitions (13 events)
│   ├── bin/                   # Guard + setup wrapper script
│   ├── skills/                # 9 skills
│   ├── rules/                 # 7 rules
│   ├── agents/                # Alfred agent
│   └── .mcp.json              # MCP server config
├── .claude-plugin/            # Marketplace manifest
├── internal/
│   ├── parser/                # JSONL parser (type definitions + parsing)
│   ├── watcher/               # File watching (fsnotify + tail)
│   ├── analyzer/              # Live stats + Feedback type + anti-pattern detector
│   ├── coach/                 # AI feedback generation via claude -p
│   ├── hookhandler/           # Hook handlers (sensor signals, workflow tracking)
│   ├── sessiondb/             # Ephemeral per-session SQLite (working set, burst state, cooldowns)
│   ├── embedder/              # Voyage AI integration for semantic search
│   ├── tui/                   # Bubble Tea TUI (watch dashboard / browse / select)
│   ├── mcpserver/             # MCP server (stdio, 7 consolidated tools)
│   ├── store/                 # SQLite persistence (vector search + docs + user profile + global DB)
│   └── install/               # Plugin bundle + initial sync + PATH symlink
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

## Semantic Search

Voyage AI (`voyage-4-large`, 2048 dimensions) powers `knowledge` and hook-based knowledge injection via vector semantic search. Set `VOYAGE_API_KEY` to enable.

Without `VOYAGE_API_KEY`, knowledge search falls back to FTS5 BM25 / LIKE — all features work, just without semantic matching.
