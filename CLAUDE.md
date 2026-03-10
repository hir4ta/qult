# claude-alfred

Silent butler for Claude Code — MCP server + Hook handler.

## Stack

Go 1.25 / SQLite (ncruces/go-sqlite3) / Voyage AI (embedding)

## Structure

| Package | Role |
|---|---|
| `internal/mcpserver` | MCP server (4 tools: knowledge, config-review, spec, recall) |
| `internal/store` | SQLite persistence (docs + docs_fts + embeddings + doc_feedback + crawl_meta) |
| `internal/embedder` | Voyage AI (voyage-4-large, hybrid vector + FTS5 + rerank-2.5) |
| `internal/spec` | Spec management: .alfred/specs/ (4 files: requirements/design/decisions/session) |
| `internal/install` | Plugin bundle + seed docs |
| `cmd/alfred/hooks*.go` | Hook handler (SessionStart / PreCompact / UserPromptSubmit / SessionEnd) |
| `cmd/alfred/setup.go` | Init TUI (API key prompt + seed progress + onboarding) |
| `cmd/alfred/status.go` | Status display (DB stats, API key, active tasks, --verbose) |
| `cmd/alfred/export.go` | Data export (memories + specs as JSON) |
| `cmd/alfred/memory.go` | Memory management (prune, stats) |
| `cmd/alfred/analytics.go` | Feedback loop analytics (injection stats, boost/penalty ranking) |
| `cmd/alfred/harvest.go` | Manual live crawl (docs, blog, news, Agent SDK → DB + embeddings) |
| `cmd/alfred/doctor.go` | System diagnostics (12 checks: DB, schema, FTS, plugin, hooks, Voyage, embeddings, crawl, MCP reachability) |
| `cmd/alfred/config.go` | Per-project config resolution (`.alfred/config.json` > env > default) |
| `cmd/alfred/settings.go` | Interactive settings (API key management) |
| `cmd/alfred/update.go` | Self-update (Homebrew > download > go install) |

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

- VOYAGE_API_KEY optional for serve and init (FTS-only fallback); init prompts interactively if unset
- `alfred settings` saves API key to shell profile (~/.zshrc or ~/.bashrc)
- Per-project config: `.alfred/config.json` overrides env vars (pointer fields for absent-vs-zero distinction)
- Custom knowledge sources: `.alfred/config.json` `custom_sources` (per-project) + `~/.claude-alfred/sources.json` (global)
- @.claude/rules/hook-internals.md (hook timeouts, env defaults, and injection thresholds)

### Hooks & Events

- Hook handler: short-lived process, no Voyage API calls. ALFRED_DEBUG=1 for debug log
- SessionStart: CLAUDE.md ingestion + spec context injection + auto-crawl check (3 ops parallel via WaitGroup)
- SessionEnd: persists session summary as permanent memory; matcher excludes reason=clear
- PreCompact: auto-updates Next Steps completion status from transcript
- Multi-agent architecture: review (3 sub-reviewers), brainstorm (2-4 specialists + synthesis), plan (2-4 specialists + mediator)

### Database & Schema

- DB schema V6+: incremental migration (V3+ preserves data, legacy schemas rebuilt)
- Store.DB() is test-only; production code uses Store methods (no raw SQL outside internal/store)
- @.claude/rules/store-internals.md (vector search, SQL safety, and FTS patterns)

### Spec Management

- Spec files use activeContext format for session.md
- task_slug: `^[a-z0-9][a-z0-9\-]{0,63}$`
- spec delete: dry-run preview (default) → `confirm=true` for actual deletion
- spec.ValidSlug: exported regex for slug validation across packages
- spec tool: DestructiveHint=false, IdempotentHint=false (safety via 2-phase delete confirm, not MCP annotation)
- Spec file locking: advisory flock on `.lock` file (exponential backoff 100/200/400/800ms ~1.5s total, context-aware cancellation, graceful fallback + stderr warning)
- Spec version history: `.history/` dir with max 20 versions per file; rollback saves current first
- Spec tool actions: init / update / status / switch / delete / history / rollback

### Memory & Feedback

- Memory persistence: source_type="memory" in docs table, TTL=0 (permanent)
- Feedback loop: doc_feedback tracks injection>reference signals, applies +/-0.15 boost with time decay (linear, 180-day floor at 50%); applied in BOTH UserPromptSubmit hook AND MCP knowledge search pipeline
- Recency signal: post-rerank exponential decay for memory (60d half-life) and changelog (30d half-life); docs not decayed (crawled_at is fetch time, not feature age); floor at 50%
- Cross-project learning: SessionStart proactively searches memories from other projects

### Crawl & Seed

- Auto-crawl: SessionStart checks last crawl age → spawns `crawl-async` background process if stale
- @.claude/rules/crawl-internals.md (lock, context, and custom source patterns)

### Misc

- config-review: maturity score (0-100) per 7 categories (claude_md, skills, rules, hooks, agents, mcp, permissions); absent categories scored at 50 baseline (not 0)
- config-review: permissions review inspects .claude/settings.json + settings.local.json allow/deny lists with conflict detection (intra-file=warning, cross-file=info, feature flags)
- config-review: hook content validation (event names, type, command non-empty, timeout range, matcher regex)
- config-review: agent deep analysis (.claude/agents/ + ~/.claude/agents/): description, model, tools, bypassPermissions warning
- doctor: MCP reachability check — verifies stdio server commands via exec.LookPath, notes package runners (npx/uvx/bunx)
- Katakana>English dictionary: built-in + user-defined override via `~/.claude-alfred/dictionary.json`
- Transcript format guard: 20-line sample, 70% parse + 50% structural validity thresholds

## Quality Gates

- At each meaningful implementation milestone, perform **thorough self-review from multiple perspectives** (delegate to another agent if possible)
- After self-review, update README.md / README.ja.md / CLAUDE.md to reflect changes
- Maintain test coverage at **80% or above** (`go test -cover ./...`; TUI packages may be excluded)

## Compact Instructions

- Preserve active spec task slug and "Currently Working On" from session.md
- Keep all CLAUDE.md rules intact (re-read from disk after compact)
- Do NOT discard in-progress implementation context or recent decisions

## Git

- **NEVER** add `Co-Authored-By` to commits (public repository)
