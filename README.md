# alfred

[![Version](https://img.shields.io/npm/v/claude-alfred)](https://www.npmjs.com/package/claude-alfred)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/github/license/hir4ta/claude-alfred)](https://github.com/hir4ta/claude-alfred/blob/main/LICENSE)

A development butler for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Specs, memory, reviews — all automatic.

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

**Specs that don't disappear.** Requirements, design, tasks, test specs — structured markdown that survives compacts and sessions. 2 files for a quick fix, 5 for a big feature. Size auto-detected.

**Memory that stacks up.** Every decision, pattern, and hard-won lesson goes to `.alfred/knowledge/` as structured JSON. Three types: decisions, patterns, rules. Git-friendly, team-shareable. alfred surfaces relevant experience before you ask.

**Reviews you can't skip.** Three enforcement layers block Edit/Write until you've reviewed. A review gate for each wave, an approval gate for M/L/XL specs, an intent guard that stops implementation without a spec. You can't YAML-edit your way past it — the signed review file gets checked too.

**Specs that stay honest.** After every commit, alfred diffs your changes against the spec. Touched a component not in the design? You'll hear about it.

**Skills that show up on their own.** Researching? alfred suggests `/brief`. Fixing a bug? `/mend`. Merged a PR? `/harvest`. No memorization needed — it watches what you're doing.

**A dashboard that's actually useful.** `alfred dashboard` opens `localhost:7575` with live task progress, spec review with inline comments, knowledge health, and activity timeline. English/Japanese toggle.

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
| **M** | 4 | New endpoint, moderate refactor |
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

## License

MIT
