# alfred

Your silent butler for Claude Code.

Alfred watches your coding sessions quietly — never interrupting, never
suggesting, never getting in the way. But the moment you turn to him, he
knows everything: which tools you rely on, how you structure your projects,
and exactly how to make your Claude Code setup world-class.

He doesn't tell you what to do. He does what you ask — perfectly.

## What Alfred Does

**When you're working** — Alfred is invisible. Eight silent hooks collect
session data with zero output. No messages, no alerts, no interruptions.

**When you call him** — Alfred already has context. Ask him to review your
project, create a skill, or improve your CLAUDE.md — he'll deliver results
backed by the latest Claude Code best practices and your personal preferences.

**He learns from history** — Alfred tracks decisions, co-changed files, and
tool failure patterns across sessions. When you revisit a file, he surfaces
what matters — without you having to ask.

## Install

Claude Code 内で:

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred@hir4ta/claude-alfred
```

Claude Code を終了し、ターミナルで:

```bash
go install github.com/hir4ta/claude-alfred@latest
```

Claude Code を再起動すれば完了。

**API key** (optional):

```bash
export VOYAGE_API_KEY=your-key       # Semantic search (Voyage AI voyage-4-large)
```

未設定の場合、検索は FTS5 キーワード検索にフォールバックします。

### Building from source

```bash
git clone https://github.com/hir4ta/claude-alfred
cd claude-alfred
go build -o claude-alfred .
```

## Skills (3)

Invoke with `/alfred:<skill-name>` in Claude Code.

| Skill | What it does |
|-------|-------------|
| `/alfred:configure <type> [name]` | Create or polish a single config file (skill, rule, hook, agent, MCP, CLAUDE.md, memory) with independent review |
| `/alfred:setup` | Project-wide setup wizard — scan and configure multiple files, or explain any Claude Code feature |
| `/alfred:harvest [--force]` | Refresh knowledge base from Claude Code documentation |

`/alfred:configure` ends with an **independent review** — a separate Explore
agent validates the generated file against official spec and knowledge base
in a forked context, catching issues the creator might miss.

## MCP Tools (4)

Backend that powers skills and the alfred agent. Claude invokes these
automatically — you don't call them directly.

| Tool | Used by | What it does |
|------|---------|-------------|
| `knowledge` | All skills (best practice lookups) | Hybrid vector + FTS5 search over Claude Code documentation |
| `recall` | Context injection, agent | Recall project context from past sessions (decisions, co-changed files, hotspots) |
| `review` | `setup` | Analyze project config + session history |
| `ingest` | `harvest` | Store documentation sections with vector embeddings |

## How It Works

```
┌─────────────────────────────────────────────────┐
│              Your Claude Code Session            │
│                                                  │
│  Hooks ──→ alfred.db                             │
│  SessionStart  (project + CLAUDE.md ingest)      │
│  PostToolUse / PostToolUseFailure (tool stats)   │
│  SubagentStart → subagent context injection      │
│  Stop / SubagentStop → decision extraction         │
│  UserPromptSubmit → past decisions context    ↑  │
│  SessionEnd                                   │  │
│                                               │  │
│  You: /alfred:configure skill                      │
│       ↓                                          │
│  Skill → MCP tools → knowledge base              │
│       ↓                                          │
│  Generated file                                  │
│       ↓                                          │
│  Independent review (Explore agent, fork)        │
│       ↓                                          │
│  Validated result                                │
└─────────────────────────────────────────────────┘
```

**Hooks** fire automatically on Claude Code lifecycle events. Most are silent;
`UserPromptSubmit` injects context when relevant:

| Hook | When | What it does |
|------|------|-------------|
| `SessionStart` | Session begins | Record project + auto-ingest CLAUDE.md + quality score + hotspots + re-inject context after compaction |
| `PostToolUse` | After tool succeeds | Record tool name and stats |
| `PostToolUseFailure` | After tool fails | Record tool failure |
| `UserPromptSubmit` | User sends prompt | Inject past decisions + co-changed files + tool failure patterns for referenced files |
| `SubagentStart` | Subagent spawned | Inject compact context (recent decisions + files + hotspots + tool failures) |
| `Stop` | Assistant stops responding | Extract decisions from response (async) |
| `SubagentStop` | Subagent finishes | Extract decisions from subagent response (async) |
| `SessionEnd` | Session closes | Finalize session statistics |

**Independent Review** — `/alfred:configure` spawns an Explore agent in a
separate context after file generation. This agent has read-only access +
knowledge base search, providing unbiased validation against official Claude
Code specifications.

## Debug

Set `ALFRED_DEBUG=1` to enable debug logging to `~/.claude-alfred/debug.log`.

## Dependencies

| Library | Purpose |
|---------|---------|
| [mcp-go](https://github.com/mark3labs/mcp-go) | MCP server SDK |
| [go-sqlite3](https://github.com/ncruces/go-sqlite3) | SQLite driver (pure Go, WASM) |

## License

MIT
