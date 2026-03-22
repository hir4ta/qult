# claude-alfred

Development butler for Claude Code — MCP server + Hook handler.

> **役割分離**: このファイル（CLAUDE.md）は **ルール・制約・行動規範** を定義する。プロジェクトの詳細な知識（アーキテクチャ、技術スタック、ディレクトリ構造）は `.alfred/steering/` のステアリングドキュメントに定義され、dossier init/status 経由で自動注入される。

## Stack

TypeScript (Node.js 22+, ESM) / SQLite (better-sqlite3) / Voyage AI (embedding) / React SPA (Vite 8 + TanStack Router + shadcn/ui)

Build: tsdown (bundle) / vitest (test) / citty (CLI) / hono (HTTP) / @modelcontextprotocol/sdk (MCP)

## Structure

| Package | Role |
|---|---|
| `src/mcp/` | MCP server (2 tools: dossier, ledger) — @modelcontextprotocol/sdk + Zod. dossier split into `src/mcp/dossier/{index,helpers,init,lifecycle,crud}.ts` |
| `src/store/` | SQLite persistence (projects + knowledge_index + spec_index + audit_log + embeddings + FTS5), project registry, spec sync, audit sync |
| `src/git/` | Git integration: export/import/diff, user.name resolution |
| `src/embedder/` | Voyage AI (voyage-4-large, vector search + rerank-2.5) |
| `src/spec/` | Spec management: .alfred/specs/ (8 file types) + Size-based scaling + Validate + Templates |
| `src/hooks/` | Hook handlers (SessionStart / PreCompact / UserPromptSubmit / PostToolUse / PreToolUse / Stop) |
| `src/api/` | HTTP API server: Hono, REST handlers, SSE, SPA serving. `schemas.ts` = Zod schema (API型の single source of truth, frontend は `import type` で参照) |
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
2. **Self-Review** (all sizes including S)
   - OK → User approval request (M/L only; S exempt)
   - NG → Fix → Self-review (loop until OK)
3. **User Spec Review** (M/L only, via `alfred dashboard`)
   - OK → Implementation phase
   - NG → Back to step 1
4. **Implementation** (per Wave, Wave-centric enforcement)
   - Each Wave ends with T-N.R Review: commit → self-review → knowledge save
   - Task completion: explicit `dossier action=check task_id="T-X.Y"` (no heuristic auto-check)
   - Wave completion: git commit detected → review gate set → Edit/Write blocked until reviewed
   - Knowledge accumulation via `ledger save` (DIRECTIVE)
5. **All Waves Complete** → Final self-review (Closing Wave)
   - OK → `dossier action=complete` (summary creation)
   - NG → Fix → Self-review (loop until OK)

### Enforcement

| Step | Mechanism | Level |
|------|-----------|-------|
| Spec required | UserPromptSubmit DIRECTIVE + PreToolUse advisory | DIRECTIVE/CONTEXT |
| Spec approval (M/L) | PreToolUse + dossier complete | DENY |
| Wave self-review | review-gate.json via PreToolUse (fix_mode for review→fix→re-review loop) | DENY (fix_mode: ALLOW) |
| Wave commit + knowledge | PostToolUse DIRECTIVE | DIRECTIVE |
| Task progress update | Explicit `dossier action=check` | Manual |
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
node dist/cli.mjs hook <Event> # Hook handler (SessionStart/PreCompact/UserPromptSubmit/PostToolUse/PreToolUse/Stop)
node dist/cli.mjs version     # Show version
```

## Release

`/release` — version auto-detected or specified.

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
- @.claude/rules/store-internals.md (schema V10, vector search, SQL safety, knowledge architecture)
- Schema V10: knowledge_index.author, audit_log table (UNIQUE dedup), idx_ki_author, idx_audit_project_time, idx_audit_actor
- rebuildFromScratch migration pattern (V9→V10)


### Spec Management & Review
- @.claude/rules/spec-details.md (sizes, types, templates, validation, confidence, approval gate, review)

### Web Dashboard

- @.claude/rules/frontend.md (component patterns, i18n)
- @.claude/rules/butler-design.md (Butler Design System: animated icons, grain texture, spring animation, empty states, organic radius, neo-brutalist accents, color storytelling)
- `alfred dashboard`: HTTP server + browser open (localhost:7575)
- React SPA: Vite 8 + TanStack Router (file-based) + TanStack Query + shadcn/ui + Tailwind CSS v4
- Build: `task build` (npm run build:web → tsdown bundle)
- Dev mode: `ALFRED_DEV=1 alfred dashboard` + `task dev` (Vite HMR proxy)
- 5 tabs: Overview (/) / Tasks (/tasks) / Knowledge (/knowledge) / Activity (/activity) / Projects (/projects)
- Cross-project: ProjectSelector filters all tabs via `?project=<uuid>`. GlobalSearch (Cmd+K) for unified knowledge+spec search
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

- Skills: brief, attend, tdd, inspect, mend, survey, salon, polish, archive
- MCP tools: dossier (spec management), ledger (knowledge)

### Deliberation Style

- **Spec review**: brief/attend focus agent review on requirements.md + design.md only (fix loop until 0 Critical/High). Other files get inline quick check
- **Code review**: attend spawns `alfred:code-reviewer` agent per Wave boundary in foreground (3 parallel sub-reviewers: security, logic, design)
- **Other skills**: inspect/salon/mend/survey use inline multi-perspective deliberation (no sub-agents)
- **Approval gate**: user reviews in `alfred dashboard`, not text-based
- tasks.md updated after each task completion (dashboard real-time progress)
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

