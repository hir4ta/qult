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

## Commands

```bash
go install ./cmd/alfred        # Build & install
go test ./...                 # All tests
go vet ./...                  # Static analysis
alfred export                 # Export memories to Git-shareable YAML
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
- PostToolUse: Bash error detection → FTS5 memory search → additionalContext injection
- Multi-agent skills: inspect (6 profiles), salon (3 specialists + synthesis), brief (3 specialists + mediator + approval gate), attend (spec→approve→implement→review→commit orchestrator), tdd (red→green→refactor autonomous cycles), mend (reproduce→analyze→fix→verify), survey (code→spec reverse engineering), harvest (PR comment → memory)

### Database & Schema

- DB schema V2: FTS5 full-text search + tag aliases (V1→V2 additive migration)
- Tables: records (memories/specs/project), embeddings (vector search), records_fts (FTS5), tag_aliases (search expansion)
- Store.DB() is test-only; production code uses Store methods (no raw SQL outside internal/store)
- @.claude/rules/store-internals.md (vector search, SQL safety patterns)

### Spec Management

- Spec files use activeContext format for session.md
- task_slug: `^[a-z0-9][a-z0-9\-]{0,63}$`
- spec delete: dry-run preview (default) → `confirm=true` for actual deletion
- spec.ValidSlug: exported regex for slug validation across packages
- dossier tool: DestructiveHint=true, IdempotentHint=false (delete action is destructive; 2-phase confirm provides UX safety)
- Dossier tool actions: init / update / status / switch / complete / delete / history / rollback / review
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
- DataSource interface for testability (internal/tui/datasource.go)

### Memory & Search

- Memory persistence: source_type="memory" in records table, TTL=0 (permanent)
- Search pipeline: Voyage vector search → rerank → recency signal → FTS5 fallback → keyword fallback
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
- Onboarding context: SessionStart adapts injection depth by project memory count (0-5: full spec, 6-20: session+goal, 21+: session only)

### Naming Convention (Butler Theme)

- Skills: brief, attend, tdd, inspect, mend, survey, salon, polish, valet, furnish, quarters, archive, concierge, harvest
- MCP tools: dossier (spec management), roster (epic management), ledger (memory)

### Agent Spawning (Rate Limit Mitigation)

- All multi-agent skills use staggered batch spawning (max 2 parallel)
- Research/critique agents: model: haiku (lower rate limits)
- Synthesis/integration agents: model: sonnet
- Pattern: Batch 1 (2 agents) → wait → Batch 2 (1-2 agents with Batch 1 context)

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
