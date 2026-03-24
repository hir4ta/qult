# claude-alfred

Development butler for Claude Code — MCP server + Hook handler.

## Stack

TypeScript (Bun 1.3+, ESM) / SQLite (bun:sqlite) / Voyage AI (embedding) / React SPA (Vite 8 + TanStack Router + shadcn/ui) / TUI (OpenTUI + @opentui/react)

Build: tsdown (bundle) / vitest (test) / citty (CLI) / hono (HTTP, Bun.serve) / @modelcontextprotocol/sdk (MCP)

## Structure

| Package | Role |
|---|---|
| `src/mcp/` | MCP server (2 tools: dossier, ledger) — @modelcontextprotocol/sdk + Zod. dossier split into `src/mcp/dossier/{index,helpers,init,lifecycle,crud}.ts` |
| `src/store/` | SQLite persistence (projects + knowledge_index + spec_index + embeddings + FTS5), project registry, spec sync |
| `src/git/` | Git integration: user.name resolution |
| `src/embedder/` | Voyage AI (voyage-4-large, vector search + rerank-2.5) |
| `src/spec/` | Spec management: .alfred/specs/ (8 file types) + Size-based scaling + Validate + Templates |
| `src/hooks/` | Hook handlers (SessionStart / PreCompact / UserPromptSubmit / PostToolUse / PreToolUse / Stop) |
| `src/api/` | HTTP API server: Hono, REST handlers, SSE, SPA serving. `schemas.ts` = Zod schema (API型の single source of truth, frontend は `import type` で参照) |
| `src/tui/` | OpenTUI terminal dashboard: real-time spec progress viewer (Bun-only, @opentui/react) |
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
   - OK → Implementation phase
   - NG → Fix → Self-review (loop until OK)
3. **Implementation** (per Wave, Wave-centric enforcement)
   - Each Wave ends with T-N.R Review: commit → self-review → knowledge save
   - Task completion: explicit `dossier action=check task_id="T-X.Y"` (no heuristic auto-check)
   - Wave completion: git commit detected → review gate set → Edit/Write blocked until reviewed
   - Knowledge accumulation via `ledger save` (DIRECTIVE)
4. **All Waves Complete** → Final self-review (Closing Wave)
   - OK → `dossier action=complete` (summary creation)
   - NG → Fix → Self-review (loop until OK)

### Enforcement

| Step | Mechanism | Level |
|------|-----------|-------|
| Spec suggested | UserPromptSubmit DIRECTIVE (AskUserQuestion で確認必須) | DIRECTIVE |
| Wave self-review | review-gate.json via PreToolUse (fix_mode for review→fix→re-review loop) | DENY (fix_mode: ALLOW) |
| Wave commit + knowledge | PostToolUse DIRECTIVE | DIRECTIVE |
| Task progress update | Explicit `dossier action=check` | Manual |
| Final self-review | Closing Wave checkbox + Stop hook | CONTEXT |

## Commands

Taskfile (task runner) を使用。`task` コマンドで実行。

```bash
task build                    # Build React SPA + tsdown (full pipeline)
task dev                      # Start Vite dev server (use with ALFRED_DEV=1 bun dist/cli.mjs dashboard)
bun src/tui/main.tsx          # TUI dashboard (real-time spec progress)
task check                    # tsc --noEmit + Biome lint
task fix                      # Biome auto-fix
task test                     # vitest
task clean                    # Clean build artifacts (dist/ + web/dist/)
bun dist/cli.mjs dashboard   # Open browser dashboard (localhost:7575)
bun dist/cli.mjs version     # Show version
```

## Release

`/release` — version auto-detected or specified.

## Rules

### Build & Distribution

- `bun run build` (tsdown) after src/ changes — output is `dist/cli.mjs`
- `plugin/` is git-tracked for marketplace distribution (hooks, mcp config, skills, agents, rules)
- MCP tools return structured JSON
- MCP server version: dynamically set from resolvedVersion() (not hardcoded)
- **dependencies はゼロ** — bun:sqlite (built-in) を使用、他のライブラリは全て devDependencies に書き tsdown でバンドル

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
- rebuildFromScratch migration pattern (V9→V10)

### Spec Management
- @.claude/rules/spec-details.md (sizes, types, templates, validation, confidence)

### Web Dashboard

- @.claude/rules/frontend.md (component patterns, i18n)
- @.claude/rules/butler-design.md (Butler Design System: animated icons, grain texture, spring animation, empty states, organic radius, neo-brutalist accents, color storytelling)
- `alfred dashboard`: HTTP server + browser open (localhost:7575)
- React SPA: Vite 8 + TanStack Router (file-based) + TanStack Query + shadcn/ui + Tailwind CSS v4
- Build: `task build` (bun run build:web → tsdown bundle)
- Dev mode: `ALFRED_DEV=1 alfred dashboard` + `task dev` (Vite HMR proxy)
- 3 tabs: Overview (+ プロジェクトリスト) / Tasks (/tasks) / Knowledge (/knowledge)
- 全プロジェクト横断表示、リアルタイム進捗(SSE)
- Markdown rendering: react-markdown + react-syntax-highlighter for rich spec display
- Brand palette (DEC-15): session #40513b, decision #628141, pattern #2d8b7a, rule #e67e22, error #c0392b, purple #7b6b8d, dark #44403c
- Knowledge lifecycle: verification badges (verified/overdue/pending), Knowledge Gaps collapsible section, `GET /api/knowledge/gaps`
- Verification: knowledge_index に verification_due/last_verified/verification_count カラム. `ledger action=verify` で Leitner 方式検証. SessionStart で期限切れ通知
- Wave enforcement: dossier complete は全 Wave のタスクチェックを検証。gate clear は reason 30文字以上必須。fix_mode は 60分タイムアウト

### Knowledge & Search

- @.claude/rules/knowledge-internals.md (persistence, search pipeline, governance, promotion)

### Naming Convention (Butler Theme)

- Skills: brief, attend, tdd, inspect, mend
- MCP tools: dossier (spec management), ledger (knowledge)

### Deliberation Style

- **Spec review**: brief/attend focus agent review on requirements.md + design.md only (fix loop until 0 Critical/High). Other files get inline quick check
- **Code review**: attend spawns `alfred:code-reviewer` agent per Wave boundary in foreground (3 parallel sub-reviewers: security, logic, design)
- **Other skills**: inspect/mend use inline multi-perspective deliberation (no sub-agents)
- tasks.md updated after each task completion (dashboard real-time progress)
- attend/mend: MUST call `dossier action=complete` at end to close spec

## Quality Gates

- At each meaningful implementation milestone, perform **thorough self-review from multiple perspectives** (delegate to another agent if possible)
- After self-review, update README.md / CLAUDE.md to reflect changes
- Maintain test coverage at **50% or above** (`bun run test`; hook handlers may be excluded)

## Compact Instructions

- Preserve active spec task slug and current progress from tasks.md
- Preserve Orchestrator State from `.alfred/.state/orchestrator-{slug}.json` (phase, iteration, counters)
- Keep all CLAUDE.md rules intact (re-read from disk after compact)
- Do NOT discard in-progress implementation context or recent decisions
