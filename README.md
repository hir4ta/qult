# alfred

[![Version](https://img.shields.io/github/v/tag/hir4ta/claude-alfred?label=version&sort=semver)](https://github.com/hir4ta/claude-alfred/releases)
[![Go](https://img.shields.io/badge/go-%3E%3D1.25-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![MIT License](https://img.shields.io/github/license/hir4ta/claude-alfred)](https://github.com/hir4ta/claude-alfred/blob/main/LICENSE)

Your development butler for Claude Code.

[Japanese README](README.ja.md)

## The problem

You're building with Claude Code. It's fast, it's smart, but:

- **It forgets.** Every compact, every new session — gone. That auth decision you spent 20 minutes debating? Ask again.
- **It wings it.** No spec, no plan. Just vibes. Works until it doesn't.
- **Nobody reviews.** The code ships without a second pair of eyes. You catch the bug in production.

alfred fixes all three.

## What it does

**Specs that survive.** Requirements, design, decisions, session state — structured markdown files that persist across compacts, sessions, and even project restarts. Your context is never lost.

**Memory that compounds.** Every decision, every bug fix, every "we tried X and it didn't work" gets stored as semantic memory. Next time you hit a similar problem, alfred surfaces the relevant experience automatically — before you even ask.

**Reviews that scale.** Six review profiles (code, config, security, docs, architecture, testing), each with a curated checklist. Parallel agents, scored reports, actionable findings.

**Approval gates.** Specs go through a review cycle before implementation. Comment on any line in the TUI dashboard, approve or request changes — like a GitHub PR review, but for your specs.

## Quick start

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred
```

```bash
export VOYAGE_API_KEY=your-key  # ~/.zshrc — enables semantic search (~$0.01/session)
```

That's it. Hooks fire automatically. Memories accumulate. Context persists.

No Voyage key? alfred still works — FTS5 full-text search handles the fallback.

## Skills

| Skill | What it does |
|-------|-------------|
| `/alfred:brief` | Design a spec. 3 agents debate your architecture, then you approve it in the dashboard |
| `/alfred:attend` | Full autopilot. Spec, review, approve, implement, test, commit — no intervention |
| `/alfred:tdd` | Test-driven. Red, green, refactor — autonomous cycles with pattern memory |
| `/alfred:inspect` | Quality gate. 6 parallel review profiles, scored report |
| `/alfred:mend` | Bug fix. Reproduce, root-cause (with past bug recall), fix, verify, commit |
| `/alfred:survey` | Reverse-engineer specs from existing code, with confidence scores |
| `/alfred:salon` | Brainstorm. 3 specialists generate ideas in parallel, then debate |
| `/alfred:harvest` | Extract knowledge from PR review comments into permanent memory |
| `/alfred:furnish` | Create or polish a config file |
| `/alfred:quarters` | Project setup wizard |
| `/alfred:archive` | Ingest reference docs into searchable knowledge |
| `/alfred:concierge` | Quick reference |

## MCP tools

| Tool | Purpose |
|------|---------|
| `dossier` | Spec lifecycle — init, update, status, switch, complete, delete, history, rollback, review |
| `roster` | Epic management — group tasks with dependencies, track progress |
| `ledger` | Memory — search past decisions and experiences, save new ones |

## Hooks

Run automatically. You don't touch these.

| Event | What happens |
|-------|-------------|
| SessionStart | Restores spec context, ingests CLAUDE.md, adapts injection depth to project maturity |
| PreCompact | Extracts decisions, saves structured chapter memory (JSON), syncs epic progress |
| UserPromptSubmit | Semantic search + file context boost — surfaces relevant past experience |
| PostToolUse | Detects Bash errors, searches memory for similar past fixes |

## TUI dashboard

```bash
alfred dashboard
```

| Tab | What you see |
|-----|-------------|
| Overview | Active task deep-dive — progress, next steps, blockers, decisions |
| Tasks | All tasks with progress bars and status |
| Specs | File browser with inline review mode (comment on lines, approve/reject) |
| Knowledge | Semantic search across all memories and specs |

The first unchecked task shimmers. You know exactly what's in progress.

## Search pipeline

alfred doesn't just do keyword matching. The search pipeline has three tiers:

1. **Voyage AI vector search** + reranking (when API key is set)
2. **FTS5 full-text search** with tag alias expansion and fuzzy matching
3. **Keyword fallback** (LIKE queries)

Tag aliases expand your searches automatically: "auth" finds results tagged "authentication", "login", and "認証".

Fuzzy matching catches typos: "authetication" still finds "authentication".

## How it works

```
You
  |
  |-- /alfred:brief    -> specs + 3-agent debate + dashboard approval
  |-- /alfred:attend   -> full cycle: spec -> approve -> implement -> review -> commit
  |-- /alfred:mend     -> reproduce -> root cause (+ past bug memory) -> fix -> verify
  |
  v
Hooks (invisible)
  |-- SessionStart     -> restore context, adapt to project maturity
  |-- PreCompact       -> save decisions as JSON, chapter memory, epic progress
  |-- UserPromptSubmit -> vector search + FTS5 + file boost -> inject memories
  |-- PostToolUse      -> detect errors -> surface related past fixes
  |
  v
Storage
  |-- .alfred/specs/       -> spec files + version history + reviews
  |-- .alfred/epics/       -> epic YAML + task dependencies
  |-- .alfred/audit.jsonl  -> operation audit trail
  |-- .alfred/knowledge/   -> exported memories (Git-shareable)
  +-- ~/.claude-alfred/    -> SQLite (records + FTS5 + Voyage embeddings)
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| No memory results | `export VOYAGE_API_KEY=your-key` — or check FTS5 fallback is working |
| Hook not firing | `/plugin install alfred` and restart |
| Dashboard empty | Run `alfred dash` from a project with `.alfred/specs/` |
| Rate limit errors | Already mitigated — agents spawn in staggered batches (max 2 parallel) |

## License

MIT
