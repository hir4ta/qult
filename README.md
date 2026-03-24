# alfred

A development butler for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Spec-driven development with persistent knowledge and self-review at every step.

**Takes longer. Ships better.**

## 30-second version

```
You: "Add user authentication"

alfred: creates spec (requirements + design + tasks) →
        self-reviews the spec (fix loop until 0 Critical) →
        implements wave by wave →
        self-reviews code at each wave boundary →
        saves what it learned for next time
```

You get slower, more deliberate development — and higher-quality output. Every decision is recorded. Every wave is reviewed. Every lesson carries forward.

## Get started

```bash
curl -fsSL https://raw.githubusercontent.com/hir4ta/claude-alfred/main/install.sh | bash
```

Then in Claude Code:

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred
```

Optional: add `export VOYAGE_API_KEY=your-key` to `~/.zshrc` for semantic search (~$0.01/session). Works fine without it — falls back to full-text search.

## What makes it different

Most spec tools give you a slash command and hope you use it. alfred uses Claude Code's hook system to **enforce** the workflow — no spec, no code edits.

**Enforcement, not suggestions.** Two gates protect your code. A spec gate blocks implementation until a spec exists. A review gate blocks the next wave until the current one passes self-review. This isn't prompt-level advice — it's PreToolUse hooks that physically deny Edit and Write.

**Self-review at every boundary.** alfred spawns parallel code-review agents (security, logic, design) at every wave boundary. Critical or high findings must be fixed before the gate opens. This adds time — but catches issues that would cost more later.

**Knowledge that compounds.** Every decision, pattern, and hard-won lesson goes to `.alfred/knowledge/` as structured JSON. Patterns auto-promote to rules after 15+ search hits. Each knowledge type has its own half-life — rules stay relevant for 120 days, assumptions fade after 30. Before you start a new task, alfred searches past experience and surfaces what's relevant.

**Specs that stay honest.** After every commit, alfred diffs your changes against the design doc. Touched a component not in the spec? You'll hear about it. New source files get auto-appended to the right component section — your spec stays in sync without manual updates.

**Context that adapts.** alfred adjusts how much it injects based on project maturity. A new project gets full spec context on session start. A mature one with 20+ knowledge entries gets just the current task and goal — no context bloat.

**Skills that show up on their own.** Researching? alfred suggests `/brief`. Fixing a bug? `/mend`. It classifies your intent (semantic or keyword, bilingual EN/JA) and nudges the right skill.

**A dashboard for visibility.** `alfred dashboard` opens `localhost:7575` with real-time task progress (SSE), spec viewing, and knowledge health. Cross-project view. English/Japanese toggle.

**Team sharing via git.** Knowledge files are structured JSON — commit, review in PRs, share with your team. No server needed — git is the transport.

## The trade-off

alfred is deliberately slower than other AI coding tools. Here's why:

- **Self-review loops add time.** Every wave boundary triggers a code review. Findings above Medium must be fixed before proceeding. This means a feature that takes 10 minutes with raw Claude might take 30 with alfred.
- **Spec-first means planning before coding.** You write requirements and design before implementation. For a quick script, that's overhead. For anything you'll maintain, it's an investment.
- **Knowledge accumulation pays off over time.** The first project is the slowest. By the third, alfred surfaces past decisions, avoids repeated mistakes, and generates specs grounded in real experience.

The bet: **time spent on review and knowledge now saves debugging and rework later.**

## Why SDD in 2026

Claude Code is powerful, but unstructured AI coding has failure modes:

- **Context loss across sessions** — even with 1M context, compaction eventually fires and wipes your working state. alfred persists decisions, patterns, and progress as structured JSON files that survive compaction, session boundaries, and model changes.
- **Infinite refactoring loops** — without bounded iteration, Claude can spend hours rewriting the same code. alfred's wave-based implementation enforces commit → review → advance.
- **Spec-implementation drift** — specs go stale the moment coding starts. alfred's living spec auto-appends changed files to design.md on every commit.
- **Security blind spots** — alfred spawns parallel code-review agents at every wave boundary, with security as a dedicated review perspective.

### Built for 1M context

With Opus 4.6's 1M context window, compaction is rarer but more destructive when it hits. alfred is designed for this reality:

- **PreCompact hook** captures structured chapter memory (goal, decisions, summary) before context is lost
- **Knowledge persistence** (`.alfred/knowledge/`) survives compaction, session restarts, and model changes
- **Adaptive injection** — new projects get full context on session start; mature projects get just the current task

## Skills

| Skill | One-liner |
|-------|-----------|
| `/alfred:attend` | Full autopilot. Spec → implement (wave by wave) → review → commit |
| `/alfred:brief` | Generate a spec. Self-review loop until 0 Critical/High findings |
| `/alfred:mend` | Bug fix. Reproduce → root-cause (with past bug knowledge) → fix → verify |
| `/alfred:tdd` | Test-driven. Red → green → refactor — remembers patterns across sessions |
| `/alfred:inspect` | Multi-perspective code review. Parallel agents, scored findings |

## How it works

```
You
  |-- /alfred:brief    -> spec + self-review loop
  |-- /alfred:attend   -> spec -> implement (wave by wave) -> review -> commit
  |-- /alfred:mend     -> reproduce -> root cause (+ past knowledge) -> fix -> verify
  v
Hooks (invisible)
  |-- SessionStart     -> restore context, sync knowledge
  |-- UserPromptSubmit -> semantic search + skill nudge + spec enforcement
  |-- PreToolUse       -> spec gate + review gate
  |-- PostToolUse      -> auto-update progress, living spec, drift detection
  |-- PreCompact       -> snapshot tasks, extract decisions
  |-- Stop             -> review gate block + reminders
  v
Storage
  |-- .alfred/knowledge/   -> JSON (decisions/, patterns/, rules/) — source of truth
  |-- .alfred/specs/       -> spec files
  +-- ~/.claude-alfred/    -> SQLite search index (rebuildable)
```

## MCP tools

| Tool | What it manages |
|------|----------------|
| `dossier` | Spec lifecycle — init, update, complete, validate, gate, check, and more |
| `ledger` | Knowledge — search, save, promote patterns to rules, audit conventions |

## Knowledge

Knowledge lives as JSON files you can commit, review in PRs, and share with your team.

```
.alfred/knowledge/
  decisions/    # "We chose X because Y. Rejected Z."
  patterns/     # "When A happens, do B. Expect C."
  rules/        # "Always do X. Priority: P0. Because: Y."
```

Patterns auto-promote to rules after 15+ search hits.

Search pipeline: Voyage AI vectors with reranking > FTS5 with BM25 ranking > keyword fallback. Tag aliases expand queries bilingually — "auth" finds "authentication", "login", "認証", and more.

Each entry tracks its author (via `git user.name`).

## Adaptive specs

| Size | Files | Good for |
|------|-------|----------|
| **S** | 3 | Bug fix, small feature |
| **M** | 4 | New endpoint, moderate refactor |
| **L** | 5 | Architecture change, new subsystem |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No search results | Set `VOYAGE_API_KEY`, or verify FTS5 fallback works |
| Wrong language | `export ALFRED_LANG=ja` in `~/.zshrc` |
| Hook not firing | `/plugin install alfred` + restart Claude Code |
| Dashboard empty | Run from a directory with `.alfred/specs/`, or any directory for cross-project view |

## Updating

```bash
alfred update    # downloads latest binary + dashboard assets from GitHub Releases
```

```
/plugin update alfred    # update skills, agents, rules (in Claude Code)
```

## Uninstalling

```bash
alfred uninstall    # removes binary, database, dashboard assets, user rules, plugin cache
```

Then in Claude Code:
```
/plugin    # select alfred → remove from marketplace
```

Note: `.alfred/` directories in your projects (specs + knowledge) are preserved.

## License

MIT
