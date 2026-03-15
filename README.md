# alfred

[![Version](https://img.shields.io/github/v/tag/hir4ta/claude-alfred?label=version&sort=semver)](https://github.com/hir4ta/claude-alfred/releases)
[![Go](https://img.shields.io/badge/go-%3E%3D1.25-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![MIT License](https://img.shields.io/github/license/hir4ta/claude-alfred)](https://github.com/hir4ta/claude-alfred/blob/main/LICENSE)

Your development butler for Claude Code.

Manages specs, remembers past experience, and watches over quality — so you can focus on building.

[Japanese README](README.ja.md)

## What pain does alfred solve?

**AI coding without specs produces inconsistent results.** alfred brings spec-driven development to Claude Code — structured requirements, design, decisions, and session state that persist across compactions and sessions.

**Past decisions and bug fixes are forgotten.** alfred remembers. Every decision, every fix is stored as semantic memory and automatically surfaced when relevant — via Voyage AI vector search on every prompt.

**Code reviews are ad-hoc.** alfred runs 6-profile parallel reviews (code, config, security, docs, architecture, testing) with curated checklists and scored reports.

**Context is lost on compact.** alfred's hooks automatically extract decisions, track modified files, and restore context — no manual intervention needed.

## Getting Started

### 1. Add the plugin

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred
```

The binary is downloaded automatically on first run.

### 2. Set API key

```bash
export VOYAGE_API_KEY=your-key  # Add to ~/.zshrc
```

[Voyage AI](https://voyageai.com/) enables semantic search (~$0.01/session).

### 3. TUI Dashboard (optional)

```bash
alfred dashboard  # or: alfred dash
```

Real-time overview of tasks, specs, decisions, and semantic knowledge search.

## Skills (14)

| Skill | What it does |
|-------|-------------|
| `/alfred:brief` | Prepare a spec — 3 agents (Architect, Devil's Advocate, Researcher) deliberate on design |
| `/alfred:attend` | Full autopilot — spec, implement, review, test, commit. No intervention needed |
| `/alfred:tdd` | Test-driven development — autonomous red/green/refactor cycles with pattern memory |
| `/alfred:inspect` | Quality review — 6 profiles with checklists, scored report |
| `/alfred:mend` | Fix a bug — reproduce, analyze root cause (with past bug memory), fix, verify, commit |
| `/alfred:survey` | Reverse-engineer — generate specs from existing code with confidence scores |
| `/alfred:salon` | Brainstorm — 3 specialists generate ideas in parallel, then debate |
| `/alfred:polish` | Refine — narrow options, score, decide |
| `/alfred:valet` | Audit skills against Anthropic's official design guide |
| `/alfred:furnish` | Create or polish a config file (skill, rule, hook, agent, MCP) |
| `/alfred:quarters` | Project setup wizard — scan and configure |
| `/alfred:archive` | Ingest reference materials into persistent knowledge |
| `/alfred:concierge` | Quick reference for all capabilities |

## MCP Tools (3)

| Tool | What it does |
|------|-------------|
| `dossier` | Spec management — init, update, status, switch, complete, delete, history, rollback |
| `roster` | Epic management — group tasks with dependencies, track progress |
| `ledger` | Memory — search past decisions and experiences, save new ones |

### Task Lifecycle

```
init → active → complete (preserves files) or delete (removes files)
```

- **complete**: Marks task done, sets `completed_at`, auto-switches primary to next active task, syncs epic status
- **delete**: Removes spec files entirely (2-phase: preview then confirm)

## Hooks (3)

Run automatically. No user action needed.

| Event | What happens |
|-------|-------------|
| SessionStart | Restore spec context + ingest CLAUDE.md (skips completed tasks) |
| PreCompact | Extract decisions + modified files + save session state + persist memories + sync epic progress |
| UserPromptSubmit | Semantic search — surface relevant past experience |

## TUI Dashboard

```bash
alfred dashboard  # alias: alfred dash
```

| Tab | Content |
|-----|---------|
| Overview | Active task deep-dive: progress bar, next steps, blockers, decisions, modified files |
| Tasks | All tasks with inline progress bars, focus text, blocker markers |
| Specs | Spec file browser with content viewer |
| Knowledge | Semantic search across memories, specs, and project docs (Voyage AI) |

## How it works

```
You (developer)
  |
  |-- /alfred:brief    -> .alfred/specs/{task}/  (requirements, design, decisions, session)
  |-- /alfred:attend   -> autonomous: spec -> review -> implement -> review -> test -> commit
  |-- /alfred:tdd      -> autonomous: red -> green -> refactor -> iterate
  |-- /alfred:mend     -> reproduce -> root cause (+ past bug memory) -> fix -> verify -> commit
  +-- /alfred:survey   -> existing code -> spec files with confidence scores
  |
  v
Hooks (automatic, invisible)
  |-- SessionStart     -> restore context from specs + CLAUDE.md
  |-- PreCompact       -> save decisions, session state, chapter memory, epic progress
  +-- UserPromptSubmit -> vector search -> inject relevant memories
  |
  v
Storage
  |-- .alfred/specs/   -> spec files (markdown, version history)
  |-- .alfred/epics/   -> epic definitions (YAML, task dependencies)
  +-- ~/.claude-alfred/alfred.db -> SQLite (docs + Voyage AI embeddings)
```

## Dependencies

| Library | Purpose |
|---------|---------|
| [mcp-go](https://github.com/mark3labs/mcp-go) | MCP server SDK |
| [go-sqlite3](https://github.com/ncruces/go-sqlite3) | SQLite (pure Go, WASM) |
| [Voyage AI](https://voyageai.com/) | Embedding + rerank (voyage-4-large) |
| [Bubbletea v2](https://github.com/charmbracelet/bubbletea) | TUI framework |

## Troubleshooting

| Symptom | Fix |
|---|---|
| No memory results | `export VOYAGE_API_KEY=your-key` |
| Hook not firing | `/plugin install alfred` and restart |
| Dashboard empty | Run `alfred dash` from a project directory with `.alfred/specs/` |

## License

MIT
