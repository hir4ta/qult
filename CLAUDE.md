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
   - a. Per Task completion: auto-update tasks.md + session.md progress (PostToolUse hook)
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
- @.claude/rules/hook-internals.md (hook timeouts)

### Hooks & Events

- Hook handler: short-lived process. 6 hooks registered in hooks.json: SessionStart, PreCompact, UserPromptSubmit, PostToolUse, PreToolUse, Stop
- Hook output: structured directive levels via `emitDirectives()` — [DIRECTIVE] (must comply), [WARNING] (should check), [CONTEXT] (reference). Max 3 DIRECTIVEs per invocation (NFR-5). Single `emitAdditionalContext()` call per hook (NFR-4)
- Directive utility: `src/hooks/directives.ts` — `buildDirectiveOutput()`, `emitDirectives()`
- Spec enforcement: UserPromptSubmit detects implement/bugfix/tdd intent + no active spec + .alfred/ exists → DIRECTIVE requiring spec creation
- Parallel dev guard: UserPromptSubmit Stage 1.5 detects implement intent + active spec exists + slug NOT in worked-slugs → WARNING prompting Claude to AskUserQuestion whether this is the same task or a new one. Suppressed once user edits files for the spec (slug added to worked-slugs)
- Spec approval gate (entry): UserPromptSubmit Stage 2 detects M/L/XL spec with review_status !== 'approved' → DIRECTIVE every prompt until approved (FR-7)
- Directive persuasion: DirectiveItem supports opt-in `rationalizations` (counter-arguments) and `spiritVsLetter` (anti-shortcut sentence). Truncation drops rationalizations first to preserve Spirit vs Letter (NFR-1)
- Semantic intent classification: Voyage embedding similarity (threshold >= 0.5) with keyword fallback. Prompt embedding reused for knowledge search (DEC-2)
- Skill nudge learning: impressions tracked in .alfred/.state/; suppressed after 3 showings per intent. resetNudgeCount(cwd, intent) exported for skill-use detection
- Hook state persistence: `src/hooks/state.ts` — readStateJSON/writeStateJSON/readStateText/writeStateText. Stores session-local state in `.alfred/.state/` (gitignored). Path traversal guard on file names
- 1% rule: SessionStart injects "invoke skills if even small chance applies" CONTEXT when .alfred/ exists (regardless of active spec)
- Test failure detection: PostToolUse recognizes FAIL/FAILED/FAILURE patterns and suggests rollback before continuing
- PostToolUse: git commit detection → proactive knowledge conflict warning (detectKnowledgeConflicts, threshold 0.70)
- PostToolUse: Edit/Write → autoCheckNextSteps with file path context (FR-8: session.md progress auto-update)
- SessionStart: decision replay — injects up to 5 recent decision-type knowledge entries (last 7 days, project-scoped). buildSpecContextItems returns items (no direct emit, NFR-4 compliant)
- Review gate: `src/hooks/review-gate.ts` — HARD enforcement via `.alfred/.state/review-gate.json`. Two gate types: `spec-review` (auto-set on dossier init, all sizes) and `wave-review` (set manually per wave). PreToolUse blocks Edit/Write when gate active + slug matches active spec. Gate cleared via `dossier action=gate sub_action=clear reason="..."` (reason required, audit logged). Fail-open on errors.
- PreToolUse: HARD enforcement — (1) review-gate blocks Edit/Write until spec/wave review completed, (2) approval gate blocks Edit/Write for unapproved M/L/XL specs. Enforcement order: .alfred/ exempt → review-gate → approval gate. Fail-open on errors (NFR-2). .alfred/ edits always allowed
- Stop: review-gate active → HARD block. Other checks (unchecked Next Steps, self-review, incomplete spec) → CONTEXT reminder only (no block). Session-scoped: only reminds about specs in worked-slugs (fallback to primary if empty). stop_hook_active=true → allow (DEC-4 infinite loop prevention)
- Worked-slugs tracking: `.alfred/.state/worked-slugs.json` — SessionStart resets, PostToolUse records active slug on Edit/Write. Used by Stop hook (session-scoped reminders) and UserPromptSubmit Stage 1.5 (suppression when already working on spec)
- Shared spec-guard utilities: `src/hooks/spec-guard.ts` — tryReadActiveSpec, isSpecFilePath, countUncheckedNextSteps, hasUncheckedSelfReview, denyTool, blockStop
- Dossier gate action: `dossier action=gate` with sub_action=set/clear/status. Set requires gate_type + optional wave. Clear requires reason (audit trail). Both set/clear logged to audit.jsonl
- Spec-first intent guard: UserPromptSubmit writes implement/bugfix/tdd intent to `.alfred/.state/last-intent.json` (30min expiry). PreToolUse blocks Edit/Write when `.alfred/` exists + no active spec + implement intent. Non-implement intents clear last-intent
- Validation engine: `src/spec/validate.ts` — 22-check validation for all spec sizes. Called by `dossier validate` and `dossier complete`. Checks: required_sections, min_fr_count, content_placeholder, fr_to_task, task_to_fr, design_fr_references, testspec_fr_references, closing_wave, gherkin_syntax, orphan_tests, orphan_tasks, confidence_annotations + size-conditional (L/XL: nfr_traceability, decisions_completeness, research_completeness; XL: confidence_coverage, xl_wave_count, xl_nfr_required; D: delta_sections/change_ids/before_after; L/XL opt-in: grounding_coverage)
- Validation gate on complete: `dossier complete` runs validateSpec() for ALL sizes. fail checks → completion rejected. warn checks → allowed
- Multi-agent skills: inspect (6 profiles), salon (3 specialists + synthesis), brief (7 spec files + 3 specialists per file + approval gate), attend (spec→approve→implement→review→commit orchestrator), tdd (red→green→refactor), mend (reproduce→analyze→fix→verify), survey (code→spec reverse engineering), harvest (PR comment → knowledge)
- brief/attend spec generation order: research → requirements → design → tasks → test-specs → session (decisions saved via ledger directly, not as spec file)
- @.claude/rules/hook-behavior.md (event pipelines, skill nudge, drift detection, dossier hints)
- @.claude/rules/implementation-discipline.md (spec-first rule, wave self-review, commit discipline)

### Database & Schema

- DB schema V8: knowledge-first architecture (any pre-V8 DB rebuilt from scratch)
- Tables: knowledge_index (knowledge entries), embeddings (vector search), knowledge_fts (FTS5), tag_aliases (search expansion), session_links (compaction continuity)
- Knowledge architecture: `.alfred/knowledge/{decisions,patterns,rules}/*.json` (mneme-compatible JSON) = source of truth; DB = derived search index (rebuildable)
- Knowledge types: decision (one-time choice + reasoning + alternatives), pattern (repeatable practice + conditions + outcomes), rule (enforceable standard + priority + rationale). `general` abolished, `snapshot` is internal-only (search excluded)
- Knowledge file write: atomic (temp + rename). writeKnowledgeFile() shared by ledger save + dossier complete
- ALFRED_LANG: controls knowledge content language (default: en). Passed in ledger/dossier responses as `lang` field for LLM language selection
- Project identification: project_remote (git remote URL) + project_path (directory) + branch; UNIQUE constraint on (project_remote, project_path, file_path)
- SessionStart sync: walks `.alfred/knowledge/{decisions,patterns,rules}/*.json` → JSON.parse → content_hash comparison → upsert. Legacy .md fallback retained. CLAUDE.md ingestion removed (v0.3.1)
- Store.DB() is test-only; production code uses Store methods (no raw SQL outside src/store/)
- @.claude/rules/store-internals.md (vector search, SQL safety patterns)

### Steering Docs

- Steering docs: `.alfred/steering/` (3 files: product.md, structure.md, tech.md)
- Pure filesystem (no DB storage, read on demand)
- `/alfred:init`: multi-agent project exploration → steering docs + templates + knowledge sync (preferred entry point)
- `alfred steering-init`: legacy CLI (redirects to /alfred:init), still functional with `--force`
- Dossier init: injects `steering_context` (summary) or `steering_hint` (suggestion) in response JSON
- Dossier update: accepts `file=steering/{filename}` for steering doc updates
- ValidateSteering: checks tech.md vs package.json drift, structure.md vs filesystem directory existence
- Templates: steering doc templates are currently not implemented (planned: file-based templates under `src/spec/templates/`)

### Spec Management

- Spec files use activeContext format for session.md
- Dossier tool actions: init / update / status / switch / complete / delete / history / rollback / review / validate
- dossier tool: DestructiveHint=true, IdempotentHint=false (delete is destructive; 2-phase confirm provides UX safety)
- dossier init: accepts optional size (S/M/L/XL/D) and spec_type (feature/bugfix/delta) params
- @.claude/rules/spec-details.md (sizes, types, templates, validation, confidence, approval gate)

### Spec Review & Approval Gate

- Web review mode: Tasks tab → View/Review tabs (only when review_status=pending)
- dossier action=review: read-only, returns latest review + unresolved comments
- Approval gate (M/L/XL): dossier complete checks BOTH _active.md review_status AND verifyReviewFile() (review JSON existence + status=approved + zero unresolved comments)
- Closing wave check: dossier complete warns if tasks.md Closing Wave has no checked items
- PreCompact auto-complete: same approval gate applied — M+ specs skip auto-complete if review not approved
- Legacy backward compat: specs without reviews/ directory pass approval gate (YAML-only, NFR-3)
- brief Step 9: approval gate after spec creation
- attend Phase 2.5: approval gate after agent review, awaiting_approval flag in Orchestrator State
- Audit log: .alfred/audit.jsonl (spec.init, spec.delete, spec.complete, review.submit)

### Epic Management

- Epic files: .alfred/epics/{slug}/epic.yaml (pure YAML, no Markdown)
- Roster tool: MCP tool for epic CRUD (init/status/link/unlink/order/list/update/delete)
- Epic→Task: link tasks with dependency ordering (topological sort)
- Epic progress: auto-synced during PreCompact (session.md status → epic.yaml)
- spec delete: auto-cleans dangling epic references (UnlinkTaskFromAllEpics)
- epic delete: tasks (specs) preserved as standalone (not deleted)
- Epic status auto-transitions: all tasks completed → epic completed

### Web Dashboard

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

- Knowledge persistence: `.alfred/knowledge/{decisions,patterns,rules}/*.json` = source of truth; DB `knowledge_index` = derived search index
- Knowledge file format: JSON (mneme-compatible schemas: DecisionEntry, PatternEntry, RuleEntry)
- Sub-type classification: decision/pattern/rule (general abolished); boost: rule=2.0x, decision=1.5x, pattern=1.3x
- Knowledge maturity: hit_count tracks search appearances, last_accessed for staleness
- Knowledge promotion: pattern→rule (15+ hits); manual confirmation via ledger promote
- Ledger tool actions: search, save, promote, candidates, reflect, audit-conventions
- Search pipeline: Voyage vector search → rerank → recency signal → hit_count tracking → FTS5 fallback → keyword fallback. Returns ScoredDoc[] with per-doc score + matchReason
- FTS5: knowledge_fts virtual table with bm25 ranking, auto-synced via triggers (title weighted 3x)
- Tag alias expansion: auth→authentication/login/認証, 16 categories bilingual (EN/JP)
- Knowledge governance: `enabled` column in knowledge_index; disabled entries excluded from search
- Knowledge tab: toggle enabled/disabled via API (PATCH /api/knowledge/{id}/enabled)
- Knowledge files are git-friendly: team sharing via repository, diff-reviewable in PRs

### Naming Convention (Butler Theme)

- Skills: brief, attend, tdd, inspect, mend, survey, salon, polish, valet, furnish, quarters, archive, concierge, harvest
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

- Preserve active spec task slug and "Currently Working On" from session.md
- Preserve `## Orchestrator State` block in session.md verbatim (phase, iteration, counters)
- Keep all CLAUDE.md rules intact (re-read from disk after compact)
- Do NOT discard in-progress implementation context or recent decisions

## Git

- **NEVER** add `Co-Authored-By` to commits (public repository)
