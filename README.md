# claude-buddy

A real-time companion TUI that runs alongside Claude Code, providing live session monitoring and AI-powered usage feedback based on official best practices.

## Install

```bash
brew install user/tap/claude-buddy
```

Or build from source:

```bash
git clone https://github.com/hir4ta/claude-buddy
cd claude-buddy
go build -o claude-buddy .
```

## Language

claude-buddy automatically detects your system locale (`LANG` / `LC_ALL` / `LC_MESSAGES`) and generates AI feedback in your language. The UI labels remain in English.

To explicitly set the language:

```bash
# Japanese
LANG=ja_JP.UTF-8 claude-buddy

# English
LANG=en_US.UTF-8 claude-buddy

# Korean
LANG=ko_KR.UTF-8 claude-buddy
```

Supported languages for AI feedback: English, Japanese, Chinese, Korean, Spanish, French, German, Portuguese, Russian, Italian, Arabic, Hindi, Thai, Vietnamese, Turkish, Polish, Dutch, Swedish.

## Commands

### `claude-buddy watch` (default)

Monitor a Claude Code session in real-time. Run in a separate terminal or tmux pane alongside Claude Code.

```bash
# Terminal 1
claude-buddy

# Terminal 2
claude
```

**Features:**

- **Header**: Session ID, turn count, tool usage, elapsed time, pulsing activity indicator
- **Task progress**: Detects TaskCreate/TaskUpdate events with shimmer effect on active tasks
  - `○` pending / `▶` in_progress (animated) / `✔` completed
- **Message stream**: Live display of user input, tool usage, assistant responses
  - `[user]` / `[answer]` / `[assistant]` / `[tool]` / `[task+]` / `[agent]` / `[msg]`
  - Expand any message with Enter to see full content in a bordered box
- **AI Feedback**: Every 3 turns, LLM evaluates your Claude Code usage against official best practices
  - `FB:` Assessment of CLAUDE.md usage, tool selection, Plan Mode, sub-agents, etc.
  - `Tip:` Concrete, actionable improvement suggestion

**Key bindings:**

| Key | Action |
|-----|--------|
| `q` / `Ctrl+C` | Quit |
| `↑` / `k` | Scroll up |
| `↓` / `j` | Scroll down |
| `Enter` | Expand/collapse message |
| `g` / `G` | Jump to top/bottom |

---

### `claude-buddy browse`

Browse past session history.

```bash
claude-buddy browse
```

---

### `claude-buddy serve`

Run as an MCP server (stdio) for Claude Code integration.

```bash
claude-buddy serve
```

**Available tools:**

| Tool | Description |
|------|-------------|
| `buddy_stats` | Session usage statistics (turns, tool frequency, duration) |
| `buddy_tips` | AI-powered feedback and tips for a session |
| `buddy_sessions` | List recent sessions |

**Integration** - Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "claude-buddy": {
      "command": "claude-buddy",
      "args": ["serve"]
    }
  }
}
```

---

### `claude-buddy analyze [session_id]`

AI-powered session analysis via `claude -p` (no extra API cost).

```bash
claude-buddy analyze          # Latest session
claude-buddy analyze de999fa4 # Specific session by ID prefix
```

Requires `claude` CLI to be installed and in PATH.

## Architecture

```
claude-buddy/
├── main.go                    # Entry point (subcommand routing)
├── internal/
│   ├── parser/                # JSONL parser
│   ├── watcher/               # File watching (fsnotify + tail)
│   ├── analyzer/              # Live stats + feedback types
│   ├── coach/                 # AI feedback via claude -p
│   ├── locale/                # Locale detection (LANG/LC_ALL)
│   ├── tui/                   # Bubble Tea TUI (watch + browse)
│   └── mcpserver/             # MCP server (stdio)
├── CLAUDE.md
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
