# alfred

Your silent butler for Claude Code.

Alfred watches your coding sessions quietly — never interrupting, never
suggesting, never getting in the way. But the moment you turn to him, he
knows everything: which tools you rely on, how you structure your projects,
and exactly how to make your Claude Code setup world-class.

He doesn't tell you what to do. He does what you ask — perfectly.

## What Alfred Does

**When you're working** — Alfred is invisible. Three silent hooks collect
session data with zero output. No messages, no alerts, no interruptions.

**When you call him** — Alfred already has context. Ask him to review your
project, create a skill, or improve your CLAUDE.md — he'll deliver results
backed by the latest Claude Code best practices and your personal preferences.

**He remembers you** — Preferences persist across every project. Tell Alfred
once that you prefer Japanese commit messages or TDD workflows, and every
artifact he creates will reflect that.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/hir4ta/claude-alfred/main/install.sh | sh
```

This downloads the binary, registers hooks/MCP/skills in Claude Code, and
syncs your session history. Restart Claude Code after installation.

**API key** (required for semantic search):

```bash
export VOYAGE_API_KEY=your-key
```

Voyage AI `voyage-4-large` (1024d). Cost ~$0.50/month.

## Uninstall

```bash
alfred uninstall
```

Removes everything: hooks, MCP server, skills, agent, rules, database, and binary.

### Alternative: Plugin install

You can also install via the Claude Code plugin system:

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred@hir4ta/claude-alfred
```

### Building from source

```bash
git clone https://github.com/hir4ta/claude-alfred
cd claude-alfred
go build -o alfred .
./alfred install
```

## Skills (7)

Invoke with `/alfred:<skill-name>` in Claude Code.

| Skill | What it does |
|-------|-------------|
| `/alfred:inspect [--quick]` | Project analysis — utilization report, quick audit, migration check |
| `/alfred:prepare <type> [name]` | Generate new config files (skill, rule, hook, agent, MCP, CLAUDE.md, memory) |
| `/alfred:polish <type> [name]` | Update existing config files against latest best practices |
| `/alfred:greetings` | Interactive setup wizard for new projects |
| `/alfred:brief <feature>` | Explain any Claude Code feature with concrete examples |
| `/alfred:memorize [pref]` | Record/view your preferences (coding style, workflow, tools) |
| `/alfred:harvest [--force]` | Refresh knowledge base (auto-harvest runs on SessionStart) |

`/alfred:prepare` and `/alfred:polish` end with an **independent review** — a
separate Explore agent validates the generated file against official spec and
knowledge base in a forked context, catching issues the creator might miss.

## MCP Tools (5)

Backend that powers skills and the alfred agent. Claude invokes these
automatically — you don't call them directly.

| Tool | Used by | What it does |
|------|---------|-------------|
| `knowledge` | All skills (best practice lookups) | Hybrid vector + FTS5 search over Claude Code documentation |
| `recall` | Context injection, agent | Recall project context from past sessions (decisions, co-changed files, hotspots) |
| `review` | `inspect`, `greetings` | Analyze project config + session history |
| `ingest` | `harvest`, auto-harvest | Store documentation sections with vector embeddings |
| `preferences` | `memorize`, `prepare`, `polish` | Get/set user preferences across projects |

## How It Works

```
┌─────────────────────────────────────────────┐
│            Your Claude Code Session          │
│                                              │
│  Hooks ──→ alfred.db                         │
│  SessionStart  (project + CLAUDE.md ingest)  │
│  PostToolUse   (tool stats)                  │
│  UserPromptSubmit → past decisions context   │
│  SessionEnd                ↑                 │
│                            │                 │
│  You: /alfred:prepare skill                   │
│       ↓                                      │
│  Skill → MCP tools → knowledge + preferences │
│       ↓                                      │
│  Generated file                              │
│       ↓                                      │
│  Independent review (Explore agent, fork)    │
│       ↓                                      │
│  Validated result                            │
└─────────────────────────────────────────────┘
```

**Hooks** fire automatically on Claude Code lifecycle events. Most are silent;
`UserPromptSubmit` injects context when relevant:

| Hook | When | What it does |
|------|------|-------------|
| `SessionStart` | Session begins | Record project + auto-ingest CLAUDE.md + auto-harvest changelog |
| `PostToolUse` | After any tool executes | Record tool name, success/failure |
| `UserPromptSubmit` | User sends prompt | Inject past decisions about referenced files as context |
| `SessionEnd` | Session closes | Finalize session statistics |

**Independent Review** — `/alfred:prepare` and `/alfred:polish` spawn an Explore
agent in a separate context after file generation. This agent has read-only
access + knowledge base search, providing unbiased validation against
official Claude Code specifications.

## TUI (Optional)

Run `alfred` in a separate terminal to watch sessions live.

```bash
alfred          # Interactive session selector + live monitor
alfred browse   # Browse past session history
```

**Key bindings:** `↑↓` navigate, `Enter` expand/collapse, `g/G` top/bottom, `?` help, `q` quit.

## Dependencies

| Library | Purpose |
|---------|---------|
| [bubbletea](https://github.com/charmbracelet/bubbletea) | TUI framework |
| [lipgloss](https://github.com/charmbracelet/lipgloss) | TUI styling |
| [fsnotify](https://github.com/fsnotify/fsnotify) | File change watching |
| [mcp-go](https://github.com/mark3labs/mcp-go) | MCP server SDK |
| [go-sqlite3](https://github.com/ncruces/go-sqlite3) | SQLite driver (pure Go, WASM) |

## License

MIT
