# alfred

[![Version](https://img.shields.io/npm/v/claude-alfred)](https://www.npmjs.com/package/claude-alfred)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/github/license/hir4ta/claude-alfred)](https://github.com/hir4ta/claude-alfred/blob/main/LICENSE)

Your development butler for Claude Code.

[Japanese README](README.ja.md)

## The problem

You're building with Claude Code. It's fast, it's smart, but three things keep going wrong.

**It forgets.** Every compact, every new session — gone. That auth decision you spent 20 minutes debating? You'll be asked again.

**It wings it.** No spec, no plan. Just vibes. Works until it doesn't.

**Nobody reviews.** Code ships without a second pair of eyes. You catch the bug in production.

alfred fixes all three.

## The approach

alfred enforces a **spec-driven development flow**. Every task follows the same structure, no exceptions.

```
Spec > Wave > Task
```

A **Spec** is a set of documents describing what you're building. A **Wave** groups related tasks into reviewable chunks. A **Task** is a single unit of work.

The flow looks like this:

1. **Create a spec** — requirements, design, tasks, test specs
2. **Self-review** — 3 AI agents debate your architecture (all sizes, including small fixes)
3. **Get approval** — review in the browser dashboard, comment on any line (M/L/XL specs)
4. **Implement wave by wave** — after each wave, commit, self-review, save what you learned
5. **Close it out** — final review, then `dossier complete`

This isn't a suggestion. Hooks enforce it. Try to write code without a spec and you'll get blocked. Try to skip a wave review and Edit/Write won't work until you do it.

## What you get

### Specs that survive

Requirements, design, decisions, session state — structured markdown that persists across compacts and sessions. Your context is never lost. Size adapts to the task: 3 files for a bug fix, 6 for a major feature.

### Memory that compounds

Every decision, every pattern, every "we tried X and it didn't work" gets stored as structured JSON in `.alfred/knowledge/`. Three types: **decisions**, **patterns**, **rules**. Git-friendly, human-readable, team-shareable. Contradictions are detected automatically. Next time you hit a similar problem, alfred surfaces the relevant experience before you even ask.

### Specs that don't drift

After every commit, alfred compares what changed against your spec. Modified a component not in the design? Warning. Convention in memory no longer matches code? Flagged.

### Reviews that scale

Six review profiles (code, config, security, docs, architecture, testing), each with a curated checklist. Parallel agents, scored reports, actionable findings.

### Approval gates that can't be bypassed

Three-layer enforcement:
- **Review gate** blocks Edit/Write until spec or wave review is done
- **Approval gate** blocks Edit/Write on unapproved M/L/XL specs
- **Intent guard** blocks implementation without a spec

The gate verifies both the review status *and* a signed review file. Manually editing the YAML won't get you past it.

### Proactive skill suggestions

alfred detects what you're doing — researching, implementing, fixing bugs, merging a PR, reading a large PDF — and suggests the right skill at the right time. No need to memorize commands.

### Browser dashboard with i18n

Real-time project overview at `localhost:7575`. Task progress, knowledge health, activity timeline, inline spec review. Switch between English and Japanese with one click.

## Quick start

### 1. Install

```bash
npm install -g claude-alfred
```

SQLite database and user rules are set up automatically. Verify with `alfred doctor`.

### 2. Plugin

In Claude Code:

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred
```

### 3. Environment

Add to `~/.zshrc` (or equivalent):

```bash
export VOYAGE_API_KEY=your-key  # enables semantic search (~$0.01/session)
export ALFRED_LANG=en           # output language (en/ja/zh/ko/fr/de/es/pt...)
```

No Voyage key? alfred still works with FTS5 full-text search as fallback.

### 4. Project setup

In Claude Code, from your project root:

```
/init    <- select "alfred" when prompted
```

This generates steering docs, sets up templates, and indexes existing knowledge.

> **Note**: Use `/init` (short form) instead of `/alfred:init`. Claude Code's autocomplete may misroute the `alfred:` prefix. Same for all skills: `/brief`, `/attend`, `/mend` etc.

## Updating

Both need to be updated together:

```bash
npm update -g claude-alfred        # CLI, hooks, MCP server, dashboard
```

```
/plugin update alfred              # skills, agents, rules (in Claude Code)
```

Run `alfred doctor` to verify both are in sync.

## Skills

### Core workflow

| Skill | What it does |
|-------|-------------|
| `/alfred:brief` | Generates a spec with 3-agent architecture review, then sends it to the dashboard for your approval |
| `/alfred:attend` | Full autopilot — spec creation, approval gate, implementation, per-wave review, commit. Hands-off |
| `/alfred:tdd` | Test-driven development. Red, green, refactor cycles with pattern memory across sessions |
| `/alfred:mend` | Bug fix workflow. Reproduce, root-cause with past bug recall, fix, verify, commit |
| `/alfred:inspect` | Quality review with 6 profiles (code, config, security, docs, architecture, testing). Parallel agents, scored findings |

### Exploration and design

| Skill | What it does |
|-------|-------------|
| `/alfred:survey` | Reverse-engineers specs from existing code, with confidence scores on every item |
| `/alfred:salon` | Brainstorm session. 3 specialists generate ideas in parallel, then debate tradeoffs |
| `/alfred:harvest` | Extracts knowledge from PR review comments and saves them as permanent memory |
| `/alfred:archive` | Ingests reference docs (PDF, CSV, large text files) into searchable knowledge |

### Setup and maintenance

| Skill | What it does |
|-------|-------------|
| `/alfred:init` | Project onboarding. Multi-agent codebase exploration, steering docs, template setup |
| `/alfred:quarters` | Project-wide Claude Code configuration wizard (settings, hooks, rules) |
| `/alfred:furnish` | Creates or polishes a single config file (skill, rule, hook, CLAUDE.md, etc.) |
| `/alfred:valet` | Audits skills against Anthropic's official guide. Scores 21 checks across 6 categories |
| `/alfred:concierge` | Quick reference for all alfred capabilities |

## MCP tools

| Tool | Purpose |
|------|---------|
| `dossier` | Spec lifecycle — init, update, status, switch, complete, delete, history, rollback, review, validate, gate |
| `roster` | Epic management — group tasks with dependencies, track progress across specs |
| `ledger` | Knowledge — search, save (decision/pattern/rule), promote (pattern to rule), reflect, audit-conventions |

## Hooks

These run automatically. You don't configure them.

| Event | What happens |
|-------|-------------|
| SessionStart | Restores spec context, syncs knowledge index, suggests missing setup (`/alfred:init`, `/alfred:quarters`) |
| UserPromptSubmit | Semantic search + skill suggestions + spec enforcement (blocks implementation without a spec, blocks unapproved M/L/XL) |
| PreToolUse | Three-layer enforcement — review gate, intent guard, approval gate. Blocks Edit/Write when gates are active |
| PostToolUse | Auto-updates task progress in tasks.md and session.md. Detects wave completion and sets review gates. Drift detection after commits. Suggests `/alfred:harvest` after PR merge, `/alfred:archive` for large reference files |
| PreCompact | Saves session snapshots, extracts decisions from transcript, syncs epic progress |
| Stop | Blocks if review gate is active. Otherwise reminds about unchecked items |

## Browser dashboard

```bash
alfred dashboard              # opens browser at localhost:7575
alfred dashboard --port 8080  # custom port
alfred dashboard --url-only   # print URL only
```

Four tabs: **Overview** (project health, task progress, memory stats), **Tasks** (drill into specs with collapsible sections, inline review mode), **Knowledge** (browse and search all memories, toggle enabled/disabled), **Activity** (operation timeline with filters).

The dashboard supports **English/Japanese switching** with one-click toggle. Your preference persists across sessions.

The first unchecked task shimmers. You always know what's in progress.

For development: `ALFRED_DEV=1 alfred dashboard` + `task dev` (in web/) enables Vite HMR.

## Steering documents

Project-level context that gets injected into every spec.

```bash
/alfred:init
```

Creates `.alfred/steering/` with three files:
- `product.md` — project purpose, target users, scope boundaries
- `structure.md` — package layout, module boundaries, naming conventions
- `tech.md` — tech stack, dependencies, architectural decisions

All three are read during `dossier init` and injected as context. Your AI always knows your architecture.

## Search pipeline

Three tiers, falling back gracefully:

1. **Voyage AI vector search** with reranking (when API key is set)
2. **FTS5 full-text search** with tag alias expansion and fuzzy matching
3. **Keyword fallback** via LIKE queries

Tag aliases expand automatically: "auth" finds "authentication", "login", and "認証". Fuzzy matching catches typos.

## Knowledge architecture

Knowledge lives as structured JSON files in your project directory. Three types, no ambiguity.

```
.alfred/knowledge/
├── decisions/    # one-time choices with reasoning + rejected alternatives
├── patterns/     # repeatable practices with conditions + expected outcomes
└── rules/        # enforceable standards with priority + rationale
```

Schemas are strict ([mneme](https://github.com/hir4ta/mneme)-compatible). All entries saved via templated parameters, so format never drifts across sessions.

Git-friendly (commit to share, review in PRs). Atomic writes (temp file + rename). Rebuildable (delete the SQLite index, it rebuilds on next session). Patterns auto-promote to rules at 15+ search hits. Contradictions detected automatically.

## Adaptive specs

Not every task needs 6 spec files.

| Size | Files | When to use |
|------|-------|-------------|
| **S** | 3 (requirements, tasks, session) | Bug fix, config change, small tweak |
| **M** | 5 (+ design, test-specs) | New endpoint, refactor, moderate feature |
| **L/XL** | 6 (+ research) | Architecture change, new subsystem |
| **D** (delta) | 2 (delta.md with CHG-N IDs, session) | Brownfield changes to existing code |
| **Bugfix** | 3-4 (bugfix.md, tasks, session, +test-specs) | Surgical bug fix with reproduction steps |

Size auto-detected from description length, or set explicitly with `dossier action=init size=S`.

## How it works

```
You
  |
  |-- /alfred:brief    -> spec + 3-agent debate + dashboard approval
  |-- /alfred:attend   -> spec -> approve -> implement (wave by wave) -> review -> commit
  |-- /alfred:mend     -> reproduce -> root cause (+ past bug memory) -> fix -> verify
  |
  v
Hooks (invisible)
  |-- SessionStart     -> restore context, sync knowledge, setup suggestions
  |-- UserPromptSubmit -> vector search + skill nudge + spec enforcement
  |-- PreToolUse       -> review gate + intent guard + approval gate (3-layer)
  |-- PostToolUse      -> task progress auto-update, wave gate, drift detection
  |-- PreCompact       -> snapshot, decision extraction, epic progress
  |-- Stop             -> review gate block + context reminders
  |
  v
Storage
  |-- .alfred/knowledge/   -> JSON source of truth (decisions/, patterns/, rules/)
  |-- .alfred/specs/       -> spec files + version history + reviews
  |-- .alfred/epics/       -> epic YAML + task dependencies
  |-- .alfred/steering/    -> project context (product, structure, tech)
  +-- ~/.claude-alfred/    -> SQLite search index (rebuildable)
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No memory results | Set `VOYAGE_API_KEY` in your shell, or check that FTS5 fallback is working |
| Output in wrong language | Set `ALFRED_LANG=ja` (or `en`, `zh`, etc.) in `~/.zshrc` |
| Hook not firing | Run `/plugin install alfred` and restart Claude Code |
| Dashboard empty | Run `alfred dashboard` from a project directory that has `.alfred/specs/` |
| Rate limit errors | Already mitigated — agents spawn in staggered batches (max 2 parallel) |

## License

MIT
