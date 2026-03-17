# alfred

[![Version](https://img.shields.io/npm/v/claude-alfred)](https://www.npmjs.com/package/claude-alfred)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
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

**Specs that adapt.** Small bug? 3 files. Medium feature? 5. Large system? All 7. alfred auto-detects the right scope — or you can pick a bugfix template with surgical precision (reproduction steps, root cause, fix strategy).

**Memory that compounds.** Every decision, every bug fix, every "we tried X and it didn't work" gets stored as Markdown files in `.alfred/knowledge/` — git-friendly, human-readable, team-shareable. A SQLite search index provides semantic search across all knowledge. Contradictions are detected automatically. Next time you hit a similar problem, alfred surfaces the relevant experience — before you even ask.

**Reliability signals.** Every spec item gets a grounding level — `verified`, `reviewed`, `inferred`, or `speculative`. You can instantly see which requirements are battle-tested and which are guesswork. Typos in grounding values get caught, not silently ignored.

**Brownfield-ready.** Delta specs for existing code changes get `CHG-N` change IDs and Before/After behavioral diffs. Not just "what file changed" but "what behavior changed and why." Three new validation checks enforce delta quality.

**Specs that don't drift.** After every commit, alfred compares what changed against your spec. Modified a component not in the design? Warning. Convention in memory no longer matches code? Flagged. No other tool does this.

**Reviews that scale.** Six review profiles (code, config, security, docs, architecture, testing), each with a curated checklist. Parallel agents, scored reports, actionable findings.

**Proactive skill suggestions.** alfred doesn't wait to be asked. It detects what you're doing — researching, designing, implementing, fixing bugs — and suggests the right skill at the right time. Explored code for a while? "Try `/alfred:survey`." Got research findings? "Save them with `ledger`." Three tasks piling up? "Group them with `roster`."

**Approval gates that can't be bypassed.** Specs go through a review cycle before implementation. Comment on any line in the browser dashboard, approve or request changes — like a GitHub PR review, but for your specs. The gate verifies both the review status *and* the existence of a signed review file, so manually editing the status won't get you past it.

**Project context that sticks.** Steering documents (product purpose, code structure, tech stack) are auto-generated from your project and injected into every spec. Your AI always knows your architecture.

## Quick start

### 1. Install

```bash
npm install -g claude-alfred
```

This automatically sets up the SQLite database and user rules. Verify with:

```bash
alfred doctor
```

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

No Voyage key? alfred still works — FTS5 full-text search handles the fallback.

### 4. Project setup

In Claude Code, from your project root:

```
/init    ← select "alfred" when prompted
```

This generates steering docs, templates, and indexes existing knowledge.

> **Note**: Use `/init` (short form) instead of `/alfred:init` — Claude Code's autocomplete may misroute the `alfred:` prefix to another skill. This applies to all alfred skills: prefer `/brief`, `/attend`, `/mend` etc.

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
| `dossier` | Spec lifecycle — init (with size/type), update, status, switch, complete, delete, history, rollback, review, validate |
| `roster` | Epic management — group tasks with dependencies, track progress |
| `ledger` | Knowledge — search, save (Markdown+frontmatter), promote, reflect, audit-conventions |

## Hooks

Run automatically. You don't touch these.

| Event | What happens |
|-------|-------------|
| SessionStart | Restores spec context, ingests CLAUDE.md, adapts injection depth to project maturity, suggests `ledger reflect` when knowledge base needs attention |
| PreCompact | Extracts decisions, saves structured chapter memory (Markdown), syncs epic progress, detects research patterns and reminds to save knowledge |
| UserPromptSubmit | Semantic search + file context boost + **skill nudge** (detects intent → suggests the right skill) |
| PostToolUse | Detects Bash errors + searches memory for similar past fixes. After commits: spec drift detection. After 5+ Read/Grep: suggests `/alfred:survey` |

## Browser dashboard

```bash
alfred dashboard              # opens browser at localhost:7575
alfred dashboard --port 8080  # custom port
alfred dashboard --url-only   # print URL only
```

| Tab | What you see |
|-----|-------------|
| **Overview** | Project health at a glance — task progress with validation badges, memory health (stale count, conflicts), confidence distribution across specs, epic progress, recent decisions |
| **Tasks** | Enriched task cards: current focus, next action, epic context, validation status. Drill into spec files. Switch to Review tab for inline comments |
| **Knowledge** | Browse all memories with sub-type tags. Semantic search (Voyage AI) with 300ms debounce. Local text filter. Toggle any memory on/off |
| **Activity** | Timeline of all operations. Filter by event type (init/complete/review). Epic drill-down with task status badges |

Inline review mode: click any spec file, switch to Review tab. Comment on specific lines, navigate review rounds, approve or request changes — all in the browser.

The first unchecked task shimmers. You know exactly what's in progress.

For development: `ALFRED_DEV=1 alfred dashboard` + `task dev` (in web/) enables Vite HMR.

## Search pipeline

alfred doesn't just do keyword matching. The search pipeline has three tiers:

1. **Voyage AI vector search** + reranking (when API key is set)
2. **FTS5 full-text search** with tag alias expansion and fuzzy matching
3. **Keyword fallback** (LIKE queries)

Tag aliases expand your searches automatically: "auth" finds results tagged "authentication", "login", and "認証".

Fuzzy matching catches typos: "authetication" still finds "authentication".

## Knowledge architecture

Knowledge is stored as Markdown files with YAML frontmatter — the source of truth lives in your project directory, not a binary database.

```
.alfred/knowledge/
├── decisions/dec-auth-jwt.md    # design decisions
├── patterns/pat-error-handling.md  # reusable patterns
└── rules/rul-no-mock-db.md     # enforced standards
```

- **Git-friendly**: commit knowledge to share with your team, review in PRs
- **Human-readable**: `cat` any file to see exactly what alfred knows
- **Rebuildable**: the SQLite search index is derived from these files — delete the DB, it rebuilds on next session
- **Sub-type decay**: Assumptions decay in 30 days. Proven rules last 120 days. Each knowledge type has its own half-life.
- **Contradiction detection**: When two entries say opposite things ("use JWT" vs "avoid JWT"), alfred flags the conflict.
- **Project-aware**: knowledge is tagged with git remote URL and branch, enabling cross-project search.

## Adaptive specs

Not every task needs 7 spec files.

| Size | Files generated | When |
|------|----------------|------|
| **S** (small) | 3: requirements, tasks, session | Bug fix, config change, small tweak |
| **M** (medium) | 5: + design, test-specs | New endpoint, refactor, moderate feature |
| **L/XL** (large) | 7: + decisions, research | Architecture change, new subsystem |
| **D** (delta) | 2: delta.md (with CHG-N IDs + Before/After), session | Brownfield changes to existing code |
| **Bugfix** | 3-4: bugfix.md, tasks, session (+ test-specs) | Surgical bug fix with reproduction steps |

Size auto-detected from description, or set explicitly: `dossier action=init size=S`.

## Spec validation

`dossier action=validate` runs 22 progressive checks:

- Required sections present (Goal, Functional Requirements, etc.)
- Minimum FR count by size (S: 1+, M: 3+, L: 5+)
- Traceability completeness (every FR mapped to a task, every task referencing an FR)
- Confidence + grounding annotations on required sections
- Closing wave present in tasks
- Grounding coverage — opt-in check: fails when >30% of items are speculative (L/XL)
- Delta spec quality — CHG-N identifiers in Files Affected, Before/After section with content

## Steering documents

Project-level context that gets injected into every spec:

```bash
/alfred:init
```

Creates `.alfred/steering/` with:
- `product.md` — project purpose, target users, business rules
- `structure.md` — package layout, module boundaries, naming conventions
- `tech.md` — tech stack, dependencies, API conventions

These docs are read during `dossier init` and injected as context, so specs are always project-aware.

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
  |-- .alfred/knowledge/   -> Markdown+frontmatter (source of truth, git-friendly)
  |-- .alfred/specs/       -> spec files + version history + reviews
  |-- .alfred/epics/       -> epic YAML + task dependencies
  |-- .alfred/steering/    -> project context (product, structure, tech)
  |-- .alfred/templates/   -> user-customizable spec + steering templates
  +-- ~/.claude-alfred/    -> SQLite search index (knowledge_index + FTS5 + embeddings, schema V8)
```

## When files are created

Nothing is generated at install time. Files appear as you use alfred:

| File / Directory | Created when | Trigger |
|---|---|---|
| `~/.claude-alfred/alfred.db` | First Claude Code session after plugin install | SessionStart hook opens the database |
| `.alfred/knowledge/` | First knowledge save (decision, pattern, rule) | `ledger action=save`, PreCompact decision extraction, spec complete |
| `.alfred/specs/` | First task is started | `dossier action=init` (via `/alfred:brief`, `/alfred:attend`, etc.) |
| `.alfred/epics/` | First epic is created | `roster action=init` |
| `.alfred/steering/` | Running `/alfred:init` | Project initialization skill |
| `.alfred/templates/` | User customizes spec or steering templates | Manual creation for template override |
| `.alfred/audit.jsonl` | First spec operation or commit drift detection | `dossier init`, `dossier delete`, review submission, PostToolUse drift |

## Troubleshooting

| Symptom | Fix |
|---|---|
| No memory results | `export VOYAGE_API_KEY=your-key` — or check FTS5 fallback is working |
| Output in wrong language | `export ALFRED_LANG=ja` (or `en`, `zh`, `ko`, etc.) in `~/.zshrc` |
| Hook not firing | `/plugin install alfred` and restart |
| Dashboard empty | Run `alfred dash` from a project with `.alfred/specs/` |
| Rate limit errors | Already mitigated — agents spawn in staggered batches (max 2 parallel) |

## License

MIT
