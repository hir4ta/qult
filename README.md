# claude-buddy

A real-time companion TUI that runs alongside Claude Code, providing live session monitoring and AI-powered usage feedback based on official best practices.

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

```bash
claude-buddy install
```

This registers the MCP server, updates `~/.claude/CLAUDE.md`, and syncs all existing sessions to the local SQLite database (`~/.claude-buddy/buddy.db`).

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

One-time setup: registers the MCP server, appends instructions to `~/.claude/CLAUDE.md`, and runs initial DB sync.

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
| `buddy_tips` | AI-powered feedback and improvement suggestions |
| `buddy_sessions` | List recent sessions with metadata |
| `buddy_resume` | Restore previous session context (summary, files modified, decisions) |
| `buddy_recall` | FTS5 full-text search across past session history |
| `buddy_decisions` | Extract design decisions from past sessions |

---

### `claude-buddy analyze [session_id]`

AI-powered session analysis via `claude -p`.

```bash
claude-buddy analyze          # Latest session
claude-buddy analyze de999fa4 # Specific session by ID prefix
```

Requires `claude` CLI in PATH.

## Architecture

```
claude-buddy/
├── main.go                    # Entry point + subcommand routing
├── internal/
│   ├── parser/                # JSONL parser (type definitions + parsing)
│   ├── watcher/               # File watching (fsnotify + tail)
│   ├── analyzer/              # Live stats + Feedback type
│   ├── coach/                 # AI feedback generation via claude -p
│   ├── locale/                # System locale detection (18 languages)
│   ├── tui/                   # Bubble Tea TUI (watch / browse / select)
│   ├── mcpserver/             # MCP server (stdio, 6 tools)
│   ├── store/                 # SQLite persistence (FTS5 + incremental sync)
│   └── install/               # MCP registration + CLAUDE.md + initial sync
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
| [ncruces/go-sqlite3](https://github.com/ncruces/go-sqlite3) | SQLite driver (FTS5 support) |
