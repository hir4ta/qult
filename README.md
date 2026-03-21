# alfred

[![Version](https://img.shields.io/npm/v/claude-alfred)](https://www.npmjs.com/package/claude-alfred)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/github/license/hir4ta/claude-alfred)](https://github.com/hir4ta/claude-alfred/blob/main/LICENSE)

A development butler for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Specs, memory, reviews — all automatic.

**Other tools suggest. alfred enforces.**

[Japanese README](README.ja.md)

## 30-second version

```
You: "Add user authentication"

alfred: creates spec (requirements + design + tasks) →
        3 agents review the architecture →
        you approve in the browser dashboard →
        implements wave by wave, committing + reviewing each →
        saves what it learned for next time
```

You just say what to build. alfred handles the rest.

## Get started

```bash
npm install -g claude-alfred
```

In Claude Code:

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred
/init    # select "alfred" — sets up steering docs + knowledge index
```

Optional: add `export VOYAGE_API_KEY=your-key` to `~/.zshrc` for semantic search (~$0.01/session). Works fine without it — falls back to full-text search.

## What makes it different

Most spec tools give you slash commands that say "you should write a spec first." alfred uses Claude Code's hook system to **physically block** Edit and Write until you do. That's the core difference — enforcement happens at the tool level, not the prompt level.

**Enforcement, not suggestions.** Three layers gate your code edits. An intent guard blocks implementation without a spec. A review gate blocks the next wave until you've reviewed the last one. An approval gate blocks M/L/XL specs until a human signs off in the dashboard. You can't YAML-edit your way past it — the signed review file gets checked too.

**Knowledge that grows up.** Every decision, pattern, and hard-won lesson goes to `.alfred/knowledge/` as structured JSON. Patterns auto-promote to rules after 15+ search hits. Each knowledge type has its own half-life — rules stay relevant for 120 days, assumptions fade after 30. Contradictions are detected automatically. Git-friendly, team-shareable, and alfred surfaces relevant experience before you ask.

**Specs that stay honest.** After every commit, alfred diffs your changes against the design doc. Touched a component not in the spec? You'll hear about it. New source files get auto-appended to the right component section — your spec stays in sync without manual updates.

**Context that adapts.** alfred adjusts how much it injects based on project maturity. A new project gets full spec context on session start. A mature one with 20+ knowledge entries gets just the current task and goal — no context bloat.

**Skills that show up on their own.** Researching? alfred suggests `/brief`. Fixing a bug? `/mend`. Merged a PR? `/harvest`. No memorization needed — it classifies your intent (semantic or keyword, bilingual) and nudges the right skill.

**A dashboard that's actually useful.** `alfred dashboard` opens `localhost:7575` with live task progress, spec review with line-level comments, file-by-file approval, knowledge health, and activity timeline. English/Japanese toggle.

## Why alfred in 2026

Claude Code is powerful, but unstructured AI coding has well-documented failure modes:

- **~30% first-attempt success rate** — without spec grounding, Claude hallucinates completions, skips edge cases, and claims "done" when it isn't. alfred's 3-layer gate system (spec → review → approval) catches these before they reach your codebase.
- **Context loss across sessions** — even with 1M context (Opus 4.6), compaction eventually fires and wipes your working state. alfred persists decisions, patterns, and progress as structured JSON files that survive any compaction, any session boundary, any model swap.
- **Infinite refactoring loops** — without bounded iteration, Claude can spend hours rewriting the same code. alfred's wave-based implementation enforces commit → review → advance. Max 2 fix rounds per wave, then escalate.
- **Security blind spots** — 45% of AI-generated code contains vulnerabilities (per industry research). alfred spawns parallel code-review agents at every wave boundary, with security as a dedicated review perspective.
- **Spec-implementation drift** — specs go stale the moment coding starts. alfred's living spec auto-appends changed files to design.md on every commit. Your spec stays honest automatically.

### SDD meets IDD

The industry is converging on two complementary paradigms: **Spec-Driven Development** (structured specs as source of truth) and **Intent-Driven Development** (capture *why* and *what*, let AI handle *how*). alfred bridges both:

- **Full SDD** for M/L/XL features — requirements, design, tasks, tests, with traceability and review gates
- **Lightweight IDD** for S/D changes — just requirements + decisions, no design overhead
- **Immutable decisions** via `ledger save` — like ADRs, but semantically searchable across projects and sessions

### Built for 1M context

With Opus 4.6's 1M context window, compaction is rarer but more destructive when it hits. alfred is designed for this reality:

- **PreCompact hook** captures structured chapter memory (goal, decisions, summary) before context is lost
- **Knowledge persistence** (`.alfred/knowledge/`) is the only data that guaranteed survives compaction, session restarts, and model changes
- **Adaptive injection** — new projects get full context on session start; mature projects get just the current task. No context bloat.

## Skills

| Skill | One-liner |
|-------|-----------|
| `/alfred:attend` | Full autopilot. Spec, approval, implementation, review, commit. Walk away |
| `/alfred:brief` | Generate a spec. 3 agents debate your architecture, then you approve in the dashboard |
| `/alfred:mend` | Bug fix. Reproduce, root-cause (with past bug memory), fix, verify |
| `/alfred:tdd` | Test-driven. Red, green, refactor — remembers patterns across sessions |
| `/alfred:inspect` | 6-profile quality review. Parallel agents, scored findings |
| `/alfred:survey` | Reverse-engineer specs from existing code, with confidence scores |
| `/alfred:salon` | Brainstorm. 3 specialists ideate in parallel, then debate tradeoffs |
| `/alfred:harvest` | Extract knowledge from PR review comments into permanent memory |
| `/alfred:archive` | Ingest reference docs (PDF, CSV, big text) into searchable knowledge |
| `/alfred:init` | Project onboarding. Multi-agent codebase exploration + steering docs |

## How it works

```
You
  |-- /alfred:brief    -> spec + 3-agent debate + dashboard approval
  |-- /alfred:attend   -> spec -> approve -> implement (wave by wave) -> review -> commit
  |-- /alfred:mend     -> reproduce -> root cause (+ past bug memory) -> fix -> verify
  v
Hooks (invisible)
  |-- SessionStart     -> restore context, sync knowledge
  |-- UserPromptSubmit -> semantic search + skill nudge + spec enforcement
  |-- PreToolUse       -> review gate + intent guard + approval gate (3-layer)
  |-- PostToolUse      -> auto-update progress, auto-transition status, drift detection
  |-- PreCompact       -> snapshot tasks, extract decisions, sync epics
  |-- Stop             -> review gate block + reminders
  v
Storage
  |-- .alfred/knowledge/   -> JSON (decisions/, patterns/, rules/) — source of truth
  |-- .alfred/specs/       -> spec files + version history + reviews
  |-- .alfred/epics/       -> epic YAML + task dependencies
  |-- .alfred/steering/    -> project context (product, structure, tech)
  +-- ~/.claude-alfred/    -> SQLite search index (rebuildable)
```

## MCP tools

| Tool | What it manages |
|------|----------------|
| `dossier` | Spec lifecycle — init, update, complete, defer, cancel, review, gate, and more |
| `roster` | Epics — group tasks with dependencies, track progress across specs |
| `ledger` | Knowledge — search, save, promote patterns to rules, health reports |

## Knowledge

Knowledge lives as JSON files you can commit, review in PRs, and share with your team.

```
.alfred/knowledge/
  decisions/    # "We chose X because Y. Rejected Z."
  patterns/     # "When A happens, do B. Expect C."
  rules/        # "Always do X. Priority: P0. Because: Y."
```

Strict schemas ([mneme](https://github.com/hir4ta/mneme)-compatible). Patterns auto-promote to rules after 15+ search hits. Contradictions detected automatically.

Search pipeline: Voyage AI vectors with reranking > FTS5 with fuzzy matching > keyword fallback. "auth" finds "authentication", "login", and more.

## Adaptive specs

| Size | Files | Good for |
|------|-------|----------|
| **S** | 2 | Bug fix, config tweak |
| **M** | 3-4 | New endpoint, moderate refactor |
| **L/XL** | 5 | Architecture change, new subsystem |
| **D** | 1 | Brownfield delta change |

## Updating

```bash
npm install -g claude-alfred        # CLI, hooks, MCP server, dashboard
```

```
/plugin update alfred              # skills, agents, rules (in Claude Code)
```

`alfred doctor` checks everything is in sync.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No memory results | Set `VOYAGE_API_KEY`, or verify FTS5 fallback works |
| Wrong language | `export ALFRED_LANG=ja` in `~/.zshrc` |
| Hook not firing | `/plugin install alfred` + restart Claude Code |
| Dashboard empty | Run from a directory with `.alfred/specs/` |

## Uninstalling

In Claude Code:

```
/plugin    # select alfred → remove from marketplace (also removes the plugin)
```

```bash
npm uninstall -g claude-alfred
rm -rf ~/.claude-alfred/                          # SQLite search index
rm -f ~/.claude/rules/alfred.md                   # user rules
rm -rf ~/.claude/plugins/cache/claude-alfred/      # plugin cache
rm -rf .alfred/                                    # project specs, knowledge, steering (per project)
```

## License

MIT
