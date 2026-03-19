# claude-alfred

Development butler for Claude Code — MCP server + Hook handler.

> **役割分離**: このファイル（CLAUDE.md）は **ルール・制約・行動規範** を定義する。プロジェクトの詳細な知識（アーキテクチャ、技術スタック、ディレクトリ構造）は `.alfred/steering/` のステアリングドキュメントに定義され、dossier init/status 経由で自動注入される。

## Stack

TypeScript (Node.js 22+, ESM) / SQLite (better-sqlite3) / Voyage AI (embedding) / React SPA (Vite 8 + TanStack Router + shadcn/ui)

Build: tsdown (bundle) / vitest (test) / citty (CLI) / hono (HTTP) / @modelcontextprotocol/sdk (MCP)

## Structure

| Package | Role |
|---|---|
| `src/mcp/` | MCP server (3 tools: dossier, roster, ledger) — @modelcontextprotocol/sdk + Zod |
| `src/store/` | SQLite persistence (knowledge_index + embeddings + FTS5), project detection |
| `src/embedder/` | Voyage AI (voyage-4-large, vector search + rerank-2.5) |
| `src/spec/` | Spec management: .alfred/specs/ (8 file types) + Size-based scaling + Validate + Templates |
| `src/epic/` | Epic management: .alfred/epics/ (YAML-based task grouping + dependencies) |
| `src/hooks/` | Hook handlers (SessionStart / PreCompact / UserPromptSubmit / PostToolUse) |
| `src/api/` | HTTP API server: Hono, REST handlers, SSE, SPA serving |
| `src/cli.ts` | CLI entry point (citty dispatch) |
| `web/` | React SPA: Vite 8, TanStack Router/Query, shadcn/ui, Tailwind CSS v4, Biome |

## Spec-Driven Development Flow (Invariant)

### Concept Hierarchy

**Spec > Wave > Task** — this hierarchy is immutable.

- A **Spec** contains one or more **Waves**
- A **Wave** contains one or more **Tasks**
- Progress updates happen per Task completion
- Knowledge accumulation and self-review happen per Wave completion

### Development Flow

1. **Spec Creation** — Create spec documents via `/alfred:brief` or `dossier action=init`
2. **Self-Review** (all sizes including S/D)
   - OK → User approval request (M/L/XL only; S/D exempt)
   - NG → Fix → Self-review (loop until OK)
3. **User Spec Review** (M/L/XL only, via `alfred dashboard`)
   - OK → Implementation phase
   - NG → Back to step 1
4. **Implementation** (per Wave)
   - a. Per Task completion: auto-update tasks.md progress (PostToolUse hook)
   - b. Per Wave completion:
     - Commit changes
     - Self-review (DENY gate: Edit/Write blocked until reviewed)
     - Knowledge accumulation via `ledger save` (DIRECTIVE)
5. **All Waves Complete** → Final self-review (Closing Wave)
   - OK → `dossier action=complete` (summary creation)
   - NG → Fix → Self-review (loop until OK)

### Enforcement

| Step | Mechanism | Level |
|------|-----------|-------|
| Spec required | UserPromptSubmit + PreToolUse | DENY |
| Spec approval (M/L/XL) | PreToolUse + dossier complete | DENY |
| Wave self-review | review-gate.json via PreToolUse | DENY |
| Wave commit + knowledge | PostToolUse DIRECTIVE | DIRECTIVE |
| Task progress update | PostToolUse autoCheckTasks | Automatic |
| Final self-review | Closing Wave checkbox + Stop hook | CONTEXT |

## Commands

Taskfile (task runner) を使用。`task` コマンドで実行。

```bash
task build                    # Build React SPA + tsdown (full pipeline)
task dev                      # Start Vite dev server (use with ALFRED_DEV=1 node dist/cli.mjs dashboard)
task check                    # tsc --noEmit + Biome lint
task fix                      # Biome auto-fix
task test                     # vitest
task clean                    # Clean build artifacts (dist/ + web/dist/)
node dist/cli.mjs serve       # MCP server (stdio)
node dist/cli.mjs dashboard   # Open browser dashboard (localhost:7575)
node dist/cli.mjs hook <Event> # Hook handler (SessionStart/PreCompact/UserPromptSubmit/PostToolUse)
node dist/cli.mjs version     # Show version
```

## Release

`/project:release` — version auto-detected or specified.

## Rules

### Build & Distribution

- `npm run build` (tsdown) after src/ changes — output is `dist/cli.mjs`
- Plugin content source of truth: `content/` (hooks, mcp config). `plugin/` is git-tracked for marketplace distribution
- MCP tools return structured JSON
- MCP server version: dynamically set from resolvedVersion() (not hardcoded)
- **npm dependencies は better-sqlite3 のみ** — 他のライブラリは全て devDependencies に書き、tsdown でバンドルする。ユーザーの `npm install` 時に追加ダウンロードを最小化するため

### Configuration & API

- VOYAGE_API_KEY enables semantic search; without it, FTS5 full-text search is used as fallback
- ALFRED_LANG sets output language for all generated content (default: en); template headings stay in English

### Hooks & Events

- Hook handler: short-lived process. 6 hooks registered in hooks.json: SessionStart, PreCompact, UserPromptSubmit, PostToolUse, PreToolUse, Stop
- @.claude/rules/hook-behavior.md (event pipelines, directives, skill nudge, drift detection, enforcement)
- @.claude/rules/hook-internals.md (hook timeouts)
- @.claude/rules/implementation-discipline.md (spec-first rule, wave self-review, commit discipline)

### Database & Schema
- @.claude/rules/store-internals.md (schema V8, vector search, SQL safety, knowledge architecture)


### Spec Management & Review
- @.claude/rules/spec-details.md (sizes, types, templates, validation, confidence, approval gate, review)

### Epic Management

- Epic files: .alfred/epics/{slug}/epic.yaml (pure YAML, no Markdown)
- Roster tool: MCP tool for epic CRUD (init/status/link/unlink/order/list/update/delete)
- Epic→Task: link tasks with dependency ordering (topological sort)
- Epic progress: auto-synced during PreCompact (tasks.md status → epic.yaml)
- spec delete: auto-cleans dangling epic references (UnlinkTaskFromAllEpics)
- epic delete: tasks (specs) preserved as standalone (not deleted)
- Epic status auto-transitions: all tasks completed → epic completed

### Web Dashboard

- @.claude/rules/frontend.md (Nova style, design system, component patterns, i18n)
- `alfred dashboard`: HTTP server + browser open (localhost:7575)
- React SPA: Vite 8 + TanStack Router (file-based) + TanStack Query + shadcn/ui + Tailwind CSS v4
- Build: `task build` (npm run build:web → tsdown bundle)
- Dev mode: `ALFRED_DEV=1 alfred dashboard` + `task dev` (Vite HMR proxy)
- 4 tabs: Overview (/) / Tasks (/tasks) / Knowledge (/knowledge) / Activity (/activity)
- Review mode: line-numbered spec viewer, inline comments, Approve/Request Changes with confirmation dialog
- Review API: POST/GET /api/tasks/:slug/review (submit review + get status + history). Creates review JSON in .alfred/specs/{slug}/reviews/
- Markdown rendering: react-markdown + react-syntax-highlighter for rich spec display
- SSE: EventSource → TanStack Query invalidation for real-time updates
- Brand palette (DEC-15): session #40513b, decision #628141, pattern #2d8b7a, rule #e67e22, error #c0392b, purple #7b6b8d, dark #44403c
- Dashboard API: Hono REST endpoints (src/api/server.ts). KnowledgeRow → KnowledgeEntry mapping via toKnowledgeEntry()
- Confidence: spec.ParseConfidence() (extracted from mcpserver to spec package)

### Knowledge & Search

- @.claude/rules/knowledge-internals.md (persistence, search pipeline, governance, promotion)

### Naming Convention (Butler Theme)

- Skills: brief, attend, tdd, inspect, mend, survey, salon, polish, archive, harvest
- MCP tools: dossier (spec management), roster (epic management), ledger (knowledge)

### Deliberation Style

- **Spec review**: brief/attend spawn 3 parallel review agents per spec file (Architect, Devil's Advocate, Researcher)
- **Code review**: attend spawns `alfred:code-reviewer` agent per implementation phase (3 parallel sub-reviewers: security, logic, design)
- **Other skills**: inspect/salon/mend/survey use inline multi-perspective deliberation (no sub-agents)
- **Approval gate**: user reviews in `alfred dashboard`, not text-based
- Session.md updated after each task completion (dashboard real-time progress)
- attend/mend: MUST call `dossier action=complete` at end to close spec

## Quality Gates

- At each meaningful implementation milestone, perform **thorough self-review from multiple perspectives** (delegate to another agent if possible)
- After self-review, update README.md / README.ja.md / CLAUDE.md to reflect changes
- Maintain test coverage at **50% or above** (`npm test`; hook handlers may be excluded)

## Compact Instructions

- Preserve active spec task slug and current progress from tasks.md
- Preserve Orchestrator State from `.alfred/.state/orchestrator-{slug}.json` (phase, iteration, counters)
- Keep all CLAUDE.md rules intact (re-read from disk after compact)
- Do NOT discard in-progress implementation context or recent decisions

## Git

- **NEVER** add `Co-Authored-By` to commits (public repository)
