# alfred

A proactive butler for Claude Code.

He works silently in the background — surfacing relevant knowledge, catching scope violations, and preserving session context across compactions — so you can focus on building.

[日本語版 README](README.ja.md)

## What alfred does

**Proactive Knowledge Injection** — Automatically surfaces relevant best practices from a 1,400+ document knowledge base when you're working on Claude Code configuration, architecture decisions, or any topic covered by the docs.

**Butler Protocol** — Structured spec management resilient to Compact and session loss. Saves requirements, design, decisions, and session state to `.alfred/specs/`, with automatic context preservation and recovery.

**3-Layer Code Review** — Checks your changes against active specs (scope violations, decision contradictions), semantic knowledge search, and best practices from documentation.

**Compact Resilience** — PreCompact hook auto-extracts decisions, tracks modified files, and saves session state in activeContext format. SessionStart hook restores full context after compaction.

## Getting Started

### 1. Add the plugin

In Claude Code:

```
/install-plugin hir4ta/claude-alfred
```

This installs skills, rules, hooks, agents, and MCP configuration.

### 2. Install the binary

```bash
go install github.com/hir4ta/claude-alfred/cmd/alfred@latest
```

Compiles the MCP server and hook handler binary. First build takes 30-60 seconds for dependencies.

### 3. Set API key

```bash
export VOYAGE_API_KEY=your-key  # Add to ~/.zshrc or equivalent
```

Semantic search uses [Voyage AI](https://voyageai.com/) for embeddings and reranking.

### 4. Initialize the knowledge base

```bash
alfred setup
```

Ingests 1,400+ official documentation sections into SQLite and generates Voyage AI embeddings. Shows TUI progress.

Restart Claude Code to finish setup.

### Build from source

```bash
git clone https://github.com/hir4ta/claude-alfred
cd claude-alfred
go install ./cmd/alfred
```

## Updating

### 1. Update the plugin

In Claude Code:

```
/install-plugin hir4ta/claude-alfred
```

### 2. Update the binary

Exit Claude Code, then:

```bash
alfred update
```

Checks for the latest version and runs `go install` automatically.

### 3. Restart Claude Code

Done.

## Skills (6)

Invoke with `/alfred:<skill>` in Claude Code.

| Skill | Description |
|-------|-------------|
| `/alfred:configure <type> [name]` | Create or polish a single config file (skill, rule, hook, agent, MCP, CLAUDE.md, memory) with independent review |
| `/alfred:setup` | Project-wide setup wizard — multi-file scan + configuration, or Claude Code feature explainer |
| `/alfred:brainstorm <theme>` | Divergent thinking — expand perspectives, options, hypotheses, and questions |
| `/alfred:refine <theme>` | Convergent thinking — fix the issue, narrow options, score, and decide |
| `/alfred:plan <task-slug>` | Butler Protocol — interactively generate a spec for compact-resilient development |
| `/alfred:review [focus]` | 3-layer knowledge-powered code review (spec + knowledge + best practices) |

## Agent (1)

| Agent | Description |
|-------|-------------|
| `alfred` | Claude Code configuration and best practices support |

## MCP Tools (9)

Backend for skills and agents. Claude calls these automatically as needed.

### Knowledge Base

| Tool | Description |
|------|-------------|
| `knowledge` | Hybrid vector + FTS5 + Voyage rerank document search |
| `config-review` | Deep audit of .claude/ config (file contents + KB cross-reference) |
| `config-suggest` | Analyze git diff and suggest .claude/ config updates |

### Butler Protocol

| Tool | Description |
|------|-------------|
| `spec-init` | Initialize a new task spec (.alfred/specs/ with 4 files + DB sync) |
| `spec-update` | Update a spec file for the active task (decisions, session state) |
| `spec-status` | Get current task state for context restoration |
| `spec-switch` | Switch the primary active task (records switch-away in old session) |
| `spec-delete` | Delete a task spec + clean DB + update _active.md |
| `code-review` | 3-layer code review (spec + semantic knowledge + best practices) |

## Hooks (4)

Run automatically during Claude Code lifecycle. No user action needed.

| Event | Action |
|-------|--------|
| SessionStart | Auto-ingest CLAUDE.md + spec context injection (adaptive recovery) |
| PreCompact | Extract context from transcript + auto-detect decisions + track modified files → save session.md in activeContext format → emit compaction instructions → async embedding |
| PreToolUse | Reminder to use alfred tools when accessing .claude/ config files |
| UserPromptSubmit | Proactive knowledge injection via FTS search, or config reminder when mentioning .claude/ paths |

## Commands

| Command | Description |
|---------|-------------|
| `serve` | Start MCP server (stdio) |
| `setup` | Initialize knowledge base (TUI progress, seed + embedding generation) |
| `hook <Event>` | Hook handler (called by Claude Code) |
| `pane <type>` | Monitoring pane (`spec` / `decisions` / `git`) with Zellij layout |
| `update` | Update to latest version (TUI progress) |
| `version` | Show version |

## Architecture

```
┌──────────────────────────────────────────────────┐
│              Claude Code Session                  │
│                                                  │
│  Hooks (automatic)                                │
│  ├ SessionStart → CLAUDE.md ingest               │
│  │                + spec context injection        │
│  ├ PreCompact  → session.md auto-save            │
│  │               (decisions + modified files)     │
│  │               + compaction instructions        │
│  │               + async embedding                │
│  ├ PreToolUse  → .claude/ access reminder         │
│  └ UserPromptSubmit → knowledge injection         │
│                                                  │
│  MCP Tools (on demand)                            │
│  ├ knowledge / config-review / config-suggest     │
│  └ spec-init / update / status / switch           │
│    / delete / code-review                         │
│                                                  │
│  Butler Protocol Flow:                            │
│  spec-init → .alfred/specs/add-auth/              │
│  (4 files + DB sync)                              │
│        ↓                                         │
│  Compact → PreCompact auto-saves                  │
│  (transcript extraction + decision detection      │
│   + git modified files → activeContext format)     │
│        ↓                                         │
│  SessionStart(compact) → adaptive recovery        │
│  (1st: all 4 files / 2nd+: session.md only)       │
└──────────────────────────────────────────────────┘
```

### Butler Protocol File Structure

```
.alfred/specs/{task-slug}/
├── requirements.md  # Goals, success criteria, out of scope
├── design.md        # Architecture, tech decisions
├── decisions.md     # Design decisions with alternatives and rationale
└── session.md       # Session state in activeContext format + Compact Markers
```

`_active.md` (YAML) manages multiple tasks; switch with `spec-switch`.

### 3-Layer Code Review (code-review)

| Layer | Search Target | Severity |
|-------|--------------|----------|
| Layer 1: Spec | decisions.md / requirements.md | critical (scope violation) / warning / info |
| Layer 2: Knowledge | Semantic search across all sources + Voyage rerank top-3 (threshold 0.3) | info |
| Layer 3: Best Practice | FTS5 document search | info |

Findings are deduplicated by `(source, message)` with highest severity preserved.

## Debugging

Set `ALFRED_DEBUG=1` to output debug logs to `~/.claude-alfred/debug.log`.

## Dependencies

| Library | Purpose |
|---------|---------|
| [mcp-go](https://github.com/mark3labs/mcp-go) | MCP server SDK |
| [go-sqlite3](https://github.com/ncruces/go-sqlite3) | SQLite driver (pure Go, WASM) |
| [bubbletea](https://github.com/charmbracelet/bubbletea) | TUI framework (setup screen) |
| [Voyage AI](https://voyageai.com/) | Embedding + rerank (voyage-4-large, 2048d) |

## License

MIT
