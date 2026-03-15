# claude-alfred

Development butler for Claude Code — MCP server + Hook handler.

## Stack

Go 1.25 / SQLite (ncruces/go-sqlite3) / Voyage AI (embedding) / Bubbletea v2 (TUI)

## Structure

| Package | Role |
|---|---|
| `internal/mcpserver` | MCP server (3 tools: dossier, roster, ledger) |
| `internal/store` | SQLite persistence (records + embeddings) |
| `internal/embedder` | Voyage AI (voyage-4-large, vector search + rerank-2.5) |
| `internal/spec` | Spec management: .alfred/specs/ (4 files: requirements/design/decisions/session) |
| `internal/epic` | Epic management: .alfred/epics/ (YAML-based task grouping + dependencies) |
| `internal/tui` | TUI dashboard: bubbletea v2 (epics/tasks/specs/memories tabs) |
| `internal/install` | Plugin bundle + user rules |
| `cmd/alfred/hooks*.go` | Hook handler (SessionStart / PreCompact / UserPromptSubmit) |
| `cmd/alfred/hooks_compact.go` | PreCompact: decision extraction, session.md rebuild, chapter memory |
| `cmd/alfred/hooks_semantic.go` | UserPromptSubmit: Voyage semantic search for memory injection |
| `cmd/alfred/hooks_transcript.go` | Transcript parsing: rich context extraction, decision detection |
| `cmd/alfred/dashboard.go` | TUI dashboard entry point (`alfred dashboard`) |

## Commands

```bash
go install ./cmd/alfred        # Build & install
go test ./...                 # All tests
go vet ./...                  # Static analysis
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

- VOYAGE_API_KEY required for UserPromptSubmit semantic search; without it, only remember hints are emitted
- @.claude/rules/hook-internals.md (hook timeouts)

### Hooks & Events

- Hook handler: short-lived process. UserPromptSubmit uses Voyage API (semantic search)
- SessionStart: CLAUDE.md ingestion + user rules check + spec context injection (2 ops parallel via channels)
- PreCompact: auto-updates Next Steps completion status from transcript; decision extraction; chapter memory persistence; epic progress auto-sync
- UserPromptSubmit: Voyage vector search for memories → inject relevant past experience
- Multi-agent skills: inspect (6 profiles), salon (3 specialists + synthesis), brief (3 specialists + mediator), attend (spec→implement→review→commit orchestrator), tdd (red→green→refactor autonomous cycles), mend (reproduce→analyze→fix→verify), survey (code→spec reverse engineering)

### Database & Schema

- DB schema V1: fresh start (pre-v1 schemas rebuilt from scratch)
- Tables: records (memories/specs/project), embeddings (vector search)
- Store.DB() is test-only; production code uses Store methods (no raw SQL outside internal/store)
- @.claude/rules/store-internals.md (vector search, SQL safety patterns)

### Spec Management

- Spec files use activeContext format for session.md
- task_slug: `^[a-z0-9][a-z0-9\-]{0,63}$`
- spec delete: dry-run preview (default) → `confirm=true` for actual deletion
- spec.ValidSlug: exported regex for slug validation across packages
- dossier tool: DestructiveHint=true, IdempotentHint=false (delete action is destructive; 2-phase confirm provides UX safety)
- Spec file locking: advisory flock on `.lock` file (exponential backoff 100/200/400/800ms ~1.5s total, context-aware cancellation, graceful fallback + stderr warning)
- Spec version history: `.history/` dir with max 20 versions per file; rollback saves current first
- Dossier tool actions: init / update / status / switch / delete / history / rollback
- Spec confidence scoring: 10-point scale via `<!-- confidence: N -->` annotations (1-3 low, 4-6 medium, 7-9 high, 10 certain); status returns avg + low_items count

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
- 4 tabs: Epics (drilldown) / Tasks / Specs (viewport) / Memories (semantic search)
- Data refresh: 5-second polling
- Style: monochrome + teal accent, no emoji, `########------` progress bars
- DataSource interface for testability (internal/tui/datasource.go)

### Memory & Search

- Memory persistence: source_type="memory" in records table, TTL=0 (permanent)
- Search pipeline: Voyage vector search → rerank → recency signal; LIKE keyword fallback when Voyage unavailable
- Recency signal: post-rerank exponential decay for memory (60d half-life); floor at 50%
- Decision extraction: base score 0.35, min confidence 0.4 — bare keyword matches require at least one positive signal (rationale/alternative/arch term)
- Background embedding: embed-async/embed-doc subcommands for async Voyage API calls
- Orphan cleanup: CleanOrphanedEmbeddings runs during PreCompact (not per-insert)

### Naming Convention (Butler Theme)

- Skills: brief, attend, tdd, inspect, mend, survey, salon, polish, valet, furnish, quarters, archive, concierge
- MCP tools: dossier (spec management), roster (epic management), ledger (memory)

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
