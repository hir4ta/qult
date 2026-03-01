# alfred

Your silent butler for Claude Code.

Alfred watches your coding sessions quietly — never interrupting, never suggesting, never getting in the way. But the moment you turn to him, he knows everything: which tools you rely on, how you structure your projects, and exactly how to make your Claude Code setup world-class.

He doesn't tell you what to do. He does what you ask — perfectly.

## What Alfred Does

**When you're working** — Alfred is invisible. Three silent hooks collect session data with zero output. No messages, no alerts, no interruptions. You won't know he's there.

**When you call him** — Alfred already has context. Ask him to review your project, and he'll analyze your CLAUDE.md, skills, rules, hooks, MCP servers, and session history. He'll tell you exactly what you're doing well and what could be better — backed by the latest Claude Code best practices.

**He remembers you** — Your preferences persist across every project. Tell Alfred once that you prefer Japanese commit messages or TDD workflows, and every skill, rule, and CLAUDE.md he creates will reflect that.

## Install

**1. Add the plugin in Claude Code:**

```
/install claude-alfred
```

**2. Set your API key:**

```bash
export VOYAGE_API_KEY=your-key
```

Cost is negligible (~$0.50/month). Uses `voyage-4-large` (1024 dimensions).

**3. Restart Claude Code** to activate hooks and MCP tools.

### Building from source

```bash
git clone https://github.com/hir4ta/claude-alfred
cd claude-alfred
go build -o claude-alfred .
```

## Skills

Skills are invoked by typing `/alfred:<skill-name>` in Claude Code. They guide Claude through a structured workflow using MCP tools behind the scenes.

### Create — "Build it for me"

| Skill | What it does |
|-------|-------------|
| `/alfred:create-skill` | Generate a skill file following best practices + your preferences |
| `/alfred:create-rule` | Generate a rule file |
| `/alfred:create-hook` | Generate hook configuration + handler |
| `/alfred:create-agent` | Generate a custom agent definition |
| `/alfred:create-mcp` | Configure an MCP server |
| `/alfred:create-claude-md` | Create or improve CLAUDE.md from project analysis |
| `/alfred:create-memory` | Set up project memory directory |

Every create skill ends with an **independent review** — a separate Explore agent validates the generated file against official spec and knowledge base, catching issues the creator might miss.

### Update — "Improve what I have"

| Skill | What it does |
|-------|-------------|
| `/alfred:update <type> [name]` | Update an existing file against latest best practices |

Supported types: `skill`, `rule`, `hook`, `agent`, `claude-md`, `memory`, `mcp`. Shows a diff with explanations before applying, then runs the same independent review.

### Analyze — "How am I doing?"

| Skill | What it does |
|-------|-------------|
| `/alfred:review` | Full utilization report — config quality, feature usage, improvement suggestions |
| `/alfred:audit` | Quick setup check against best practices |

### Learn — "Remember this"

| Skill | What it does |
|-------|-------------|
| `/alfred:learn` | Record your preferences (workflow, style, tools) |
| `/alfred:preferences` | View what Alfred remembers about you |
| `/alfred:update-docs` | Refresh Claude Code documentation in knowledge base |

### Power — "Level up my setup"

| Skill | What it does |
|-------|-------------|
| `/alfred:setup` | Interactive wizard — CLAUDE.md + skills + rules + hooks in one go |
| `/alfred:migrate` | Update your setup to match latest best practices |
| `/alfred:explain` | Learn about any Claude Code feature with examples |

## MCP Tools

MCP tools are the backend that powers skills and the alfred agent. You don't call them directly — Claude Code invokes them automatically when a skill or agent needs data.

| Tool | When it's called | What it does |
|------|-----------------|-------------|
| `knowledge` | Skills search for best practices or docs | Hybrid vector + FTS5 search over Claude Code documentation |
| `review` | `/alfred:review`, `/alfred:audit`, `/alfred:setup` | Analyze project config (CLAUDE.md, skills, rules, hooks, MCP, sessions) |
| `ingest` | `/alfred:update-docs` crawls documentation | Store documentation sections with vector embeddings |
| `preferences` | `/alfred:learn` records, `/alfred:create:*` reads | Get/set user preferences that persist across projects |

## How It Works

Alfred is a Claude Code plugin with three invisible hooks and four MCP tools.

**Hooks** fire automatically on Claude Code lifecycle events. They silently record session data to `alfred.db` — no output, no interruption:

| Hook | When it fires | What it records |
|------|--------------|----------------|
| `SessionStart` | Session begins or resumes | Project path, session ID |
| `PostToolUse` | After any tool executes | Tool name, success/failure |
| `SessionEnd` | Session closes | Final session statistics |

**MCP Tools** are called by Claude when a skill or agent needs data (see above).

**Skills** are invoked by you with `/alfred:<name>` (see above).

```
┌─────────────────────────────────────────┐
│           Your Claude Code Session       │
│                                          │
│  Silent hooks ──→ alfred.db              │
│  (you see nothing)    ↑                  │
│                       │                  │
│  You: "/alfred:review"                   │
│       ↓                                  │
│  MCP tools ──→ analysis + knowledge base │
│       ↓                                  │
│  Alfred: complete report                 │
└─────────────────────────────────────────┘
```

## TUI (Optional)

Run `claude-alfred` in a separate terminal to watch sessions live.

```bash
claude-alfred          # Interactive session selector + live monitor
claude-alfred browse   # Browse past session history
```

**Key bindings:** `↑↓` scroll, `Enter` expand/collapse, `g/G` top/bottom, `?` help, `q` quit.

## Commands

| Command | Description |
|---------|-------------|
| `claude-alfred` | Monitor active session in real-time (default) |
| `claude-alfred browse` | Browse past session history |
| `claude-alfred serve` | Run as MCP server (stdio) |
| `claude-alfred hook <Event>` | Handle silent hook events |
| `claude-alfred install` | Sync sessions and generate embeddings |
| `claude-alfred uninstall` | Remove MCP server registration |
| `claude-alfred plugin-bundle` | Generate plugin directory |

## Architecture

```
claude-alfred/
├── main.go                 # Entry point + subcommand routing
├── plugin/                 # Claude Code plugin (generated)
│   ├── hooks/              # 3 silent hooks (SessionStart, PostToolUse, SessionEnd)
│   ├── skills/             # 16 skills (create, update, analyze, learn, power)
│   ├── rules/              # 7 rules (Claude Code best practices)
│   ├── agents/             # 1 agent (alfred)
│   └── .mcp.json           # MCP server config
├── internal/
│   ├── parser/             # JSONL parser
│   ├── watcher/            # File watching (fsnotify)
│   ├── analyzer/           # Live session statistics
│   ├── embedder/           # Voyage AI (voyage-4-large, 1024d)
│   ├── tui/                # Bubble Tea TUI
│   ├── mcpserver/          # MCP server (4 tools)
│   ├── store/              # SQLite (vector search, docs, preferences)
│   └── install/            # Plugin bundle + sync + PATH symlink
└── go.mod
```

## Dependencies

| Library | Purpose |
|---------|---------|
| [bubbletea](https://github.com/charmbracelet/bubbletea) | TUI framework |
| [lipgloss](https://github.com/charmbracelet/lipgloss) | TUI styling |
| [fsnotify](https://github.com/fsnotify/fsnotify) | File change watching |
| [mcp-go](https://github.com/mark3labs/mcp-go) | MCP server SDK |
| [go-sqlite3](https://github.com/ncruces/go-sqlite3) | SQLite driver (pure Go) |

## License

MIT
