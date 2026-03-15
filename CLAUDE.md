# claude-alfred

Development butler for Claude Code — MCP server + Hook handler.

## Stack

Go 1.25 / SQLite (ncruces/go-sqlite3) / Voyage AI (embedding) / Bubbletea v2 (TUI)

## Structure

| Package | Role |
|---|---|
| `internal/mcpserver` | MCP server (3 tools: dossier, roster, ledger) |
| `internal/store` | SQLite persistence (records + embeddings + FTS5 full-text search) |
| `internal/embedder` | Voyage AI (voyage-4-large, vector search + rerank-2.5) |
| `internal/spec` | Spec management: .alfred/specs/ (4 files + reviews + audit log) |
| `internal/epic` | Epic management: .alfred/epics/ (YAML-based task grouping + dependencies) |
| `internal/tui` | TUI dashboard: bubbletea v2 (overview/tasks/specs/knowledge tabs + review mode) |
| `internal/install` | Plugin bundle + user rules |
| `cmd/alfred/hooks*.go` | Hook handler (SessionStart / PreCompact / UserPromptSubmit / PostToolUse) |
| `cmd/alfred/hooks_compact.go` | PreCompact: decision extraction, structured chapter memory (JSON), session.md rebuild |
| `cmd/alfred/hooks_semantic.go` | UserPromptSubmit: Voyage semantic search + FTS5 fallback + file context boost |
| `cmd/alfred/hooks_posttool.go` | PostToolUse: Bash error detection → related memory injection |
| `cmd/alfred/hooks_transcript.go` | Transcript parsing: rich context extraction, decision detection |
| `cmd/alfred/dashboard.go` | TUI dashboard entry point (`alfred dashboard`) |
| `cmd/alfred/export.go` | Knowledge export (`alfred export` → .alfred/knowledge/memories.yaml) |
| `cmd/alfred/search_eval.go` | Search quality benchmark (`alfred search-eval`) |

## Commands

```bash
go install ./cmd/alfred        # Build & install
go test ./...                 # All tests
go vet ./...                  # Static analysis
alfred export                 # Export memories to Git-shareable YAML
alfred search-eval            # Run search quality benchmark
```

## Release

`/project:release` — version auto-detected or specified.

## Rules

### Build & Distribution

- Always `go install ./cmd/alfred` after changes (`go build` + `cp` breaks macOS code signing)
- `internal/` packages are private APIs
- MCP tools return structured JSON
- MCP server version: dynamically set from resolvedVersion() (not hardcoded)

### Configuration & API

- VOYAGE_API_KEY enables semantic search; without it, FTS5 full-text search is used as fallback
- @.claude/rules/hook-internals.md (hook timeouts)

### Hooks & Events

- Hook handler: short-lived process. UserPromptSubmit uses Voyage API (semantic search) or FTS5 fallback
- SessionStart: CLAUDE.md ingestion + user rules check + spec context injection (2 ops parallel via channels) + adaptive onboarding (memory count → context depth)
- PreCompact: auto-updates Next Steps completion status from transcript; decision extraction; structured chapter memory (JSON); epic progress auto-sync
- UserPromptSubmit: Voyage vector search → FTS5 fallback → keyword fallback; file context boost from git diff
- PostToolUse: Bash error detection → FTS5 memory search → additionalContext injection; Bash success → session.md Next Steps auto-check (command + action signals matching)
- Multi-agent skills: inspect (6 profiles), salon (3 specialists + synthesis), brief (3 specialists + mediator + approval gate), attend (spec→approve→implement→review→commit orchestrator), tdd (red→green→refactor autonomous cycles), mend (reproduce→analyze→fix→verify), survey (code→spec reverse engineering), harvest (PR comment → memory)

### Database & Schema

- DB schema V4: hit_count + last_accessed columns (V3→V4 additive migration)
- Tables: records (memories/specs/project), embeddings (vector search), records_fts (FTS5), tag_aliases (search expansion), session_links (compaction continuity)
- Store.DB() is test-only; production code uses Store methods (no raw SQL outside internal/store)
- @.claude/rules/store-internals.md (vector search, SQL safety patterns)

### Spec Management

- Spec files use activeContext format for session.md
- task_slug: `^[a-z0-9][a-z0-9\-]{0,63}$`
- spec delete: dry-run preview (default) → `confirm=true` for actual deletion
- spec.ValidSlug: exported regex for slug validation across packages
- dossier tool: DestructiveHint=true, IdempotentHint=false (delete action is destructive; 2-phase confirm provides UX safety)
- Dossier tool actions: init / update / status / switch / complete / delete / history / rollback / review
- Spec cross-references: `@spec:task-slug/file.md` format parsed by `spec.ParseRefs()`, resolved against filesystem
- dossier status: includes `references` (outgoing + incoming), dangling detection
- dossier init: returns `suggested_knowledge` (related memories via vector search + FTS5 fallback, sub_type boosted)
- dossier delete preview: warns about incoming refs that will become dangling
- Spec file locking: advisory flock on `.lock` file (exponential backoff 100/200/400/800ms ~1.5s total, context-aware cancellation, graceful fallback + stderr warning)
- Spec version history: `.history/` dir with max 20 versions per file; rollback saves current first
- Task lifecycle: active → complete (preserves spec files, sets completed_at) or delete (removes files)
- ActiveTask fields: slug, started_at, status (active/completed), completed_at, review_status (pending/approved/changes_requested)
- complete action: marks task completed, switches primary to next active task, syncs epic status
- Spec confidence scoring: 10-point scale via `<!-- confidence: N -->` annotations (1-3 low, 4-6 medium, 7-9 high, 10 certain); status returns avg + low_items count

### Spec Review & Approval Gate

- Review data: .alfred/specs/{slug}/reviews/review-{timestamp}.json
- ReviewComment: file, line (1-based), body, resolved
- Review status: pending → approved or changes_requested (stored in _active.md review_status)
- TUI review mode: Specs tab → overlay → 'r' key (only when review_status=pending)
- dossier action=review: read-only, returns latest review + unresolved comments
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

### TUI Dashboard

- `alfred dashboard` (alias: `alfred dash`): bubbletea v2 TUI
- 4 tabs: Overview (drilldown) / Tasks / Specs (review mode) / Knowledge (semantic search)
- Data refresh: 5-second polling
- Style: purple accent (#af87d7) + orange shimmer (#f0a050) for active items, no emoji
- Shimmer animation: lipgloss.Blend1D gradient, 50ms tick, on first unchecked Next Steps item
- Review mode: line-numbered viewer, inline comments (orange), background-highlighted cursor, Approve/Request Changes
- Review history: round navigation (left/right keys), read-only past rounds, carried-over unresolved comments (dim orange)
- DataSource interface for testability (internal/tui/datasource.go)

### Memory & Search

- Memory persistence: source_type="memory" in records table, TTL=0 (permanent), sub_type classification (general/decision/pattern/rule)
- Memory sub_type boost: rule=2.0x, decision=1.5x, pattern=1.3x, general=1.0x (search relevance)
- Knowledge maturity: hit_count tracks search result appearances, last_accessed for staleness detection
- Knowledge promotion: general→pattern (5+ hits), pattern→rule (15+ hits); manual confirmation via ledger promote
- Ledger tool actions: search, save, promote, candidates, reflect
- Knowledge health (ledger reflect): stats + conflict detection + stale memories + promotion candidates
- Search quality benchmark: `alfred search-eval` CLI subcommand with .alfred/search-eval.yaml test cases
- PreCompact promotion injection: candidates above threshold surfaced in additionalContext
- Search pipeline: Voyage vector search → rerank → recency signal → hit_count tracking → FTS5 fallback → keyword fallback
- FTS5: records_fts virtual table with bm25 ranking, auto-synced via triggers
- Tag alias expansion: auth→authentication/login/認証, 16 categories bilingual (EN/JP)
- Fuzzy search: Levenshtein distance on section_path (max dist = min(2, len/3))
- Conflict detection: DetectConflicts pairwise cosine similarity (threshold 0.75) on memory embeddings
- Progressive Disclosure: ledger search detail parameter (compact/summary/full)
- File context boost: git diff → FTS5 search by changed filenames → score boost
- Recency signal: post-rerank exponential decay for memory (60d half-life); floor at 50%
- Structured chapter memory: JSON schema (goal, technologies, modified_files, decisions, blockers)
- Decision extraction: base score 0.35, min confidence 0.4 — bare keyword matches require at least one positive signal (rationale/alternative/arch term)
- Background embedding: embed-async/embed-doc subcommands for async Voyage API calls
- Orphan cleanup: CleanOrphanedEmbeddings runs during PreCompact (not per-insert)
- Session continuity: PreCompact writes .alfred/.pending-compact.json breadcrumb, SessionStart resolves → session_links table (master session tracking)
- Auto-complete: PreCompact auto-completes task when session.md Status="completed"/"done" or all Next Steps are checked
- Onboarding context: SessionStart adapts injection depth by project memory count (0-5: full spec, 6-20: session+goal, 21+: session only)

### Naming Convention (Butler Theme)

- Skills: brief, attend, tdd, inspect, mend, survey, salon, polish, valet, furnish, quarters, archive, concierge, harvest
- MCP tools: dossier (spec management), roster (epic management), ledger (memory)

### Deliberation Style

- **Spec review**: brief/attend spawn 3 parallel review agents per spec file (Architect, Devil's Advocate, Researcher)
- **Code review**: attend spawns `alfred:code-reviewer` agent per implementation phase (3 parallel sub-reviewers: security, logic, design)
- **Other skills**: inspect/salon/mend/survey use inline multi-perspective deliberation (no sub-agents)
- **Approval gate**: user reviews in `alfred dashboard`, not text-based
- Session.md updated after each task completion (dashboard real-time progress)
- attend/mend: MUST call `dossier action=complete` at end to close spec

### Misc

- Transcript format guard: 20-line sample, 70% parse + 50% structural validity thresholds

## Quality Gates

- At each meaningful implementation milestone, perform **thorough self-review from multiple perspectives** (delegate to another agent if possible)
- After self-review, update README.md / README.ja.md / CLAUDE.md to reflect changes
- Maintain test coverage at **50% or above** (`go test -cover ./...`; TUI packages and hook handlers may be excluded)

## Compact Instructions

- Preserve active spec task slug and "Currently Working On" from session.md
- Preserve `## Orchestrator State` block in session.md verbatim (phase, iteration, counters)
- Keep all CLAUDE.md rules intact (re-read from disk after compact)
- Do NOT discard in-progress implementation context or recent decisions

## Git

- **NEVER** add `Co-Authored-By` to commits (public repository)
