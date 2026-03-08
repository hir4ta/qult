# Changelog

All notable changes to claude-alfred are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.60.3] - 2026-03-08

### Fixed
- **Critical**: `RecordFeedback` SQL injection pattern — replaced `fmt.Sprintf` column interpolation with two literal SQL statements
- **Critical**: `memory prune` orphaned embeddings — new `DeleteMemoriesBefore` method cleans docs + embeddings + doc_feedback in a single transaction
- `readFileTail` double file open / defer double-close — use `io.ReadAll(f)` on small-file path
- `spawnCrawlAsync` lock file wrote "spawning" placeholder instead of actual PID
- `lockFileExists` stale comment referencing removed "spawning" state
- `CountDocsBySourceTypeAndAge` returned `int` instead of `int64` (inconsistent with other count methods)

### Changed
- 12 regexps in `HTMLToText`/`stripJSX`/`extractHTMLTitle`/`stripHTMLTags` moved to package-level `var` (compiled once, not per-call)
- Store abstraction: `memory.go`, `export.go`, `status.go` no longer use `st.DB()` directly — new Store methods: `CountDocsBySourceType`, `CountDocsBySourceTypeAndAge`, `ListMemoriesBefore`, `DeleteMemoriesBefore`, `MemoryStatsByProject`, `QueryDocsBySourceType`
- `QueryDocsBySourceType` uses `DocOrderBy` typed enum instead of raw string for ORDER BY clause
- `Crawl()` accepts `context.Context` for cancellation propagation to HTTP requests
- `sync.Once` vocab cache replaced with `sync.Mutex` + `bool` for safe `ResetVocabCache` in tests
- `spec` file name extraction uses `strings.TrimSuffix` instead of byte-length arithmetic
- `recall` MCP tool: added `IdempotentHintAnnotation`, description clarifies READ/WRITE per action
- `Stop` hook registered in plugin bundle hooks.json for backward compatibility with older Claude Code versions
- `alfred.md` rule: added `description` frontmatter field

### Added
- README badges: version (dynamic from GitHub tag), Go version, license, release workflow status
- README Architecture section: Mermaid diagrams (system overview + Alfred Protocol lifecycle sequence)

## [0.60.2] - 2026-03-08

### Fixed
- `buildSessionSummary` incomplete fallback migration: legacy session headings (`## Current Position`, `## Pending`) silently lost in permanent memory records
- `InstallUserRules` unconditional overwrite: added skip-if-unchanged via content comparison
- `InstallUserRules` missing deprecated rule cleanup: stale files from previous versions now removed on install

### Changed
- DRY refactor: `extractSectionFallback` variadic helper replaces repeated if-empty-fallback patterns across hooks
- Removed dead code: `formatTranscriptContext` and `extractTranscriptContext` (replaced by `extractTranscriptContextRich`)
- `alfred init` post-setup message: "Installed" → "Updated" for rule file count

## [0.60.1] - 2026-03-08

### Added
- `/alfred:help` skill: quick reference for all capabilities (skills, agents, MCP tools, CLI commands)
- `alfred export [--all]` command: export memories (and optionally specs) as JSON
- `alfred memory prune [--confirm]` command: remove old memories with dry-run preview
- `alfred memory stats` command: memory statistics by project
- `alfred status --verbose`: environment overrides and memory-by-project breakdown
- `ALFRED_QUIET=1` environment variable: suppress knowledge injection in UserPromptSubmit and proactive hints
- `ALFRED_MEMORY_MAX_AGE_DAYS` environment variable: configurable cutoff for memory pruning (default 180)
- Onboarding guidance after `alfred init` completion

### Changed
- Hook lifecycle: Stop → SessionEnd with `reason` field support (backward-compatible, both events handled)
- SessionEnd skips memory persistence when `reason=clear`
- `DestructiveHint` annotation: `true` → `false` on spec tool (safety via 2-phase delete confirm)
- MCP tool descriptions: added response format documentation to all 4 tools
- code-reviewer agent: added `permissionMode: plan`
- brainstorm/review/setup skills: added `model: sonnet`
- setup skill: added `context: fork` for isolated execution

### Fixed
- `rows.Err()` checks added to all `rows.Next()` loops in export.go, memory.go, status.go
- `crawled[:10]` panic guard for short date strings in memory prune display
- `defer specRows.Close()` inside loop → explicit Close in export.go
- Scan errors now logged via debugf instead of silently discarded
- `QueryRowContext` error check added in memory stats
- Double DB connection eliminated in status verbose section (gatherStatus refactor)

## [0.60.0] - 2026-03-08

### Added
- Implicit feedback loop: doc_feedback table tracks injection→reference signals, applies ±0.1 additive boost
- Cross-project learning: SessionStart proactively searches memories from other projects
- Transcript format guard: 20-line sample, 70% parse + 50% structural validity thresholds
- Katakana→English dictionary: built-in + user-defined override via `~/.claude-alfred/dictionary.json`
- HTTP conditional requests (ETag/If-Modified-Since) via crawl_meta table for diff-based auto-crawl
- `FeedbackBoostBatch`: batch query replacing N+1 per-doc feedback lookups
- Spec file locking: advisory flock on `.lock` file in spec directory (graceful fallback)

### Changed
- FTS5 query sanitization: individual terms sanitized via `JoinFTS5Terms()` before OR-joining (consistency fix)
- Feedback boost: multiplicative → additive to prevent death spiral on threshold-marginal scores
- Orphan cleanup: `DeleteExpiredDocs` now removes stale doc_feedback rows (`NOT EXISTS` pattern)
- `GetRecentInjections`: added `LIMIT 20` for bounded hook-timeout queries
- Crawl lock: `O_CREATE|O_EXCL` atomic file creation replacing WriteFile TOCTOU pattern
- `Process.Release()` ordering: PID captured before Release() in all async spawn functions

### Fixed
- FTS5 injection in `proactiveHintsForNextSteps`: `strings.Join` → `store.JoinFTS5Terms()`
- Stale PID access after `Process.Release()` in `asyncEmbedDoc` and `spawnCrawlAsync`
- Crawl lock race: `lockFileExists()` guard catches transient "spawning" state

## [0.59.0] - 2026-03-08

### Added
- Background auto-crawl: SessionStart checks last crawl age and spawns `crawl-async` if stale (default 7 days, configurable via `ALFRED_CRAWL_INTERVAL_DAYS`)
- `crawl-async` subcommand: background process for live doc fetch + DB upsert + optional embedding
- `store.LastCrawledAt()` convenience method for crawl age checks
- Lock file with PID-based stale detection for concurrent crawl prevention

### Changed
- `ApplySeedData` embedder is now optional: nil embedder → FTS-only mode (no vector embeddings)
- `validateProjectPath` falls back to `os.Getwd()` when `project_path` is omitted (all MCP tools)
- README.md / README.ja.md updated with auto-crawl documentation

### Fixed
- `isCrawlRunning`: use `syscall.Signal(0)` instead of `os.Signal(nil)` (nil interface panic)
- TOCTOU race in crawl spawning: write lock file before `cmd.Start()`, not after
- Lock file write failure now aborts crawl instead of silently continuing unlocked

## [0.58.2] - 2026-03-08

### Changed
- Extract `hybridSearchPipeline()` — deduplicate ~50 lines between knowledge search and recall handlers
- Add `io.LimitReader` to all HTTP response reads (seed_fetch 10MB, voyage errors 64KB, checksums 1MB)
- Add `DestructiveHintAnnotation(true)` to spec MCP tool (delete action is destructive)
- Review skill: Glob fallback for code-reviewer agent path resolution in plugin cache

## [0.58.1] - 2026-03-08

### Fixed
- HybridSearch vector source hardcoded to "docs" — now derives from sourceType (memory search quality fix)
- Hook handlers discarding caller's `context.Context` — propagate ctx through all helper functions
- embedWarning overwrite in cascade failures — accumulate warnings in slice
- Non-voyageError implicit retry fall-through — add explicit `continue` for network errors
- Review skill implicit dependency on code-reviewer agent — specify path + add missing-file fallback

### Changed
- AppendFile comment: document hook serialization assumption (no concurrent lost updates)
- entryFromRaw: avoid double JSON unmarshal in transcript parsing
- Plugin metadata: rules `globs` → `paths`, add `category`, add hook `statusMessage`
- Rerank retry: exponential backoff matching embed pattern (was single-attempt)
- Context propagation: all DB-facing store methods now accept `context.Context`

## [0.58.0] - 2026-03-08

### Added
- Multi-agent code review: 3 parallel sub-reviewers (security, logic, design) with LLM blind spot checklists
- Multi-agent brainstorm: 3 parallel experts (Visionary, Pragmatist, Critic) with cross-critique synthesis
- Multi-agent plan: 3 parallel agents (Architect, Devil's Advocate, Researcher) with deliberation
- PreToolUse matcher expanded: `Edit|Write` → `Edit|Write|MultiEdit`
- MCP server version: dynamic from build ldflags (was hardcoded `1.0.0`)
- `sha256sum` fallback in run.sh for Linux compatibility

### Changed
- Personality alignment: "proactive assistant" → "silent butler" across all user-facing surfaces
- User-facing text localized to English (notifyUser, buildSessionSummary, CHANGELOG)
- Release skill localized to English
- `configReminder`: fixed tool name `review` → `config-review`

## [0.57.0] - 2026-03-08

### Added
- `alfred status` command — rich display of DB stats, API key status, active tasks, paths
- `alfred settings` command — interactive TUI for API key management (persists to shell profile)
- `alfred init` interactive API key prompt (enter key when unset, Esc for FTS-only mode)
- `Store.CountEmbeddings()` method
- `envFloat` range validation [0,1] + parse error logging

### Fixed
- `isClaudeConfigPath` substring match `.claude/` → `/.claude/` (prevents false match on `myclaude/`)
- marketplace.json version sync (0.55.0 → 0.57.0)
- Remove unused Supabase permissions from settings.local.json
- Add explicit `context: current` to configure skill (consistency with plan)

### Changed
- `alfred init` works in FTS-only mode when VOYAGE_API_KEY is unset
- Channel sync with `atomic.Bool` for safe double-close prevention

## [0.56.1] - 2026-03-08

### Added
- Persistent memory (source_type="memory", TTL=0)
- recall MCP tool (memory-specific search and save)
- Stop hook: persist session summary to memory
- Async embedding (spec/memory docs)
- Japanese FTS support (kagome IPA dictionary)

### Fixed
- Remove duplicate hooks field from plugin.json

## [0.55.0] - 2026-03-08

### Fixed
- **[Critical]** Add `validateProjectPath` to `reviewHandler` (path traversal vulnerability)
- **[Critical]** Capture `UpsertDoc` return value in `ingestProjectClaudeMD` (fix complete error discard)
- Add `PRAGMA user_version` scan error logging (fix silent fallback)
- `downloadRelease`: `os.Getenv("HOME")` → `os.UserHomeDir()` for consistency
- Fix `removeOldestCompactMarker` comment (logic was correct)

### Changed
- Atomize schema migration with `BEGIN/COMMIT` transactions (`execer` interface)
- Atomize `DeleteDocsByURLPrefix` / `DeleteExpiredDocs` with transactions
- spec tool: remove `DestructiveHintAnnotation` (documented per-action in description)
- spec tool: remove `Required()` from `project_path` (resolve description conflict)
- brainstorm/refine/plan: remove `WebSearch`/`WebFetch` (curated knowledge approach)
- brainstorm/refine: add `disable-model-invocation: true` (prevent auto-invocation)
- configure/setup/refine: remove undefined `context: current`
- alfred-protocol rule: add `globs: .alfred/**` (conditional loading)
- alfred agent: `memory: user` → `memory: project` (prevent multi-project contamination)
- plugin.json: add `hooks` field (explicit manifest over auto-discovery)
- Remove empty `settings.json` (auto-generated during bundle)

## [0.54.4] - 2026-03-08

### Fixed
- Add `rows.Err()` checks (docs.go ×2 + vectors.go ×1) — fix missed I/O errors in scan loops
- `RowsAffected()` error propagation (DeleteDocsByURLPrefix)
- Unify Rerank API errors to `voyageError` type (API key masking on 401/403)
- Fix configure skill implementation gaps (non-existent Explore agent ref, unimplemented constraint tags ref)
- Debug log permissions 0644 → 0600 (fix world-readable)
- Add justification comments for `_` error ignores in UpsertDoc (go-errors rule compliance)

### Changed
- Propagate ctx to `ingestProjectClaudeMD` in `handleSessionStart` (future context-aware extensibility)
- Change unused ctx to `_ context.Context` in `handleUserPromptSubmit` (Go idiom)
- Add `## Compact Instructions` section to CLAUDE.md

## [0.54.3] - 2026-03-08

### Changed
- PreToolUse matcher narrowed to `Edit|Write` (remove `Read` to reduce unnecessary fires)
- Mandatory SHA256 checksum verification in run.sh (exit 1 on download failure)
- Add per-event `context.WithTimeout` to hook handler (graceful cleanup before external timeout)
- Unify PreCompact DB sync via hook context

### Added
- `store.DebugLog` callback — surface store scan errors in debug log (3 locations)
- Add `disable-model-invocation: true` to release skill (prevent auto-release by Claude)

## [0.54.2] - 2026-03-08

### Changed
- Fix spec tool `DestructiveHintAnnotation` to `true` (delete action is destructive)
- Minimize Bash permissions for skills/agents: review/setup/release/code-reviewer
- Narrow PreToolUse matcher to `Read|Edit|Write` (exclude Glob|Grep)
- PreToolUse timeout 3s → 2s (align with official <2s recommendation)
- Globalize alfred-protocol rule (remove `.alfred/**` paths restriction)
- Unify MCP tool names to `mcp__plugin_alfred_alfred__*` full names
- Remove redundant model definitions from settings.json (agents frontmatter is authoritative)

## [0.54.1] - 2026-03-08

### Fixed
- Remove unsupported `category` field from plugin.json (fix plugin validation error)

## [0.54.0] - 2026-03-08

### Changed
- Graceful degradation: stderr warnings on store/DB open failures (hooks_session, hooks_compact)
- Voyage API 401/403 error masking to prevent API key leakage in logs
- `ambiguousKeywords` DRY refactor: generated from `frameworkFamilies` table
- Spec tool annotation: `destructiveHint: false` (status is read-only)
- PreToolUse hook matcher expanded: `Read|Edit|Write|Glob|Grep`
- Skills overhaul: plan (slug validation), brainstorm (query guidance), refine (flexible templates), review (git diff guidance), setup (stack defaults), configure (hook types updated)
- Agents improvements: code-reviewer (spec-less fallback), alfred (Write/Edit usage clarified)
- Rules improvements: alfred-protocol (Compact Marker format), alfred (spec tool docs)

### Added
- Code-reviewer agent model setting in settings.json
- VOYAGE_API_KEY env passthrough in .mcp.json
- README: Spec File Templates, Troubleshooting section, environment variables table

## [0.53.0] - 2026-03-08

### Added
- CHANGELOG.md for tracking changes
- UTF-8 safe string truncation (`safeSnippet`) for content snippets
- Session.md size limit (512KB) with automatic oldest marker removal
- Git availability check before running git commands
- Voyage API transient error detection with multiple patterns (`isVoyageTransient`)
- Embed/hybrid search warnings surfaced in MCP tool results
- Hook timeout rationale documented in CLAUDE.md

### Changed
- Voyage API retry: linear backoff → exponential backoff (2s, 4s)
- code-reviewer agent: Bash restricted to `git*` commands only
- Magic number constants annotated with design rationale

### Fixed
- UTF-8 truncation: byte-based `snippet[:300]` → rune-based `safeSnippet()`
- Silent error handling: added comments justifying skip-on-error in store scan loops

## [0.52.0] - 2026-03-07

### Added
- Path traversal protection for spec file operations
- code-reviewer agent with read-only enforcement
- YAML parser standardization (gopkg.in/yaml.v3)

### Changed
- Ambiguous keyword detection improved (framework negation)

## [0.51.0] - 2026-03-06

### Added
- SHA-256 content hash for change detection in docs
- Comprehensive error handling improvements

### Changed
- Seed docs updated with latest Claude Code documentation

## [0.50.0] - 2026-03-05

### Added
- Proactive knowledge injection via SessionStart (Next Steps keyword analysis)
- Maturity scoring (0-100) for config-review
- Dry-run preview for spec delete
- Environment variable thresholds for hook tuning

## [0.49.0] - 2026-03-03

### Added
- MCP tools consolidated to 3 (knowledge, config-review, spec)
- Server instructions for tool discovery
- Transcript version guard for format changes

## [0.48.0] - 2026-03-02

### Added
- Kagome IPA dictionary for Japanese morphological analysis
- Snowball stemming for English keywords
- Improved Japanese knowledge injection accuracy

## [0.47.0] - 2026-02-28

### Added
- Unified spec tool (init/update/status/switch/delete)
- PreCompact transcript context extraction improvements
- run.sh SHA256 checksum verification

## [0.46.0] - 2026-02-27

### Changed
- Renamed Butler → Alfred throughout
- Removed LLM gate (keyword filter + FTS only)
- Improved test coverage

## [0.45.0] - 2026-02-25

### Added
- Homebrew distribution (no Go required for installation)
- CLI UX improvements

## [0.44.0] - 2026-02-24

### Added
- UserPromptSubmit 2-layer design (keyword gate + FTS injection)
- Unified rules
- Enhanced test coverage

## [0.43.0] - 2026-02-23

### Added
- Hook handler split into separate files
- go:embed for bundled assets
- Voyage configuration via environment variables
- VectorSearch upper bound (maxVectorCandidates)

## [0.42.0] - 2026-02-22

### Added
- Active-mode transformation with confidence scoring
- Synonym dictionary for keyword matching
- E2E tests
- Spec 4-file format (requirements/design/decisions/session)

## [0.41.0] - 2026-02-21

### Added
- Compact resilience (session recovery after context compaction)
- Code review capabilities
- Task management via spec tool

## [0.40.0] - 2026-02-20

### Added
- Initial Alfred Protocol (spec-based task management)
- Brainstorm, refine, plan skills
- PreCompact hook with transcript analysis
- Decision extraction from conversation transcripts

[Unreleased]: https://github.com/hir4ta/claude-alfred/compare/v0.60.3...HEAD
[0.60.3]: https://github.com/hir4ta/claude-alfred/compare/v0.60.2...v0.60.3
[0.60.2]: https://github.com/hir4ta/claude-alfred/compare/v0.60.1...v0.60.2
[0.60.1]: https://github.com/hir4ta/claude-alfred/compare/v0.60.0...v0.60.1
[0.60.0]: https://github.com/hir4ta/claude-alfred/compare/v0.59.0...v0.60.0
[0.59.0]: https://github.com/hir4ta/claude-alfred/compare/v0.58.2...v0.59.0
[0.58.1]: https://github.com/hir4ta/claude-alfred/compare/v0.58.0...v0.58.1
[0.58.0]: https://github.com/hir4ta/claude-alfred/compare/v0.57.0...v0.58.0
[0.57.0]: https://github.com/hir4ta/claude-alfred/compare/v0.56.1...v0.57.0
[0.56.1]: https://github.com/hir4ta/claude-alfred/compare/v0.55.0...v0.56.1
[0.58.2]: https://github.com/hir4ta/claude-alfred/compare/v0.58.1...v0.58.2
[0.55.0]: https://github.com/hir4ta/claude-alfred/compare/v0.54.4...v0.55.0
[0.54.4]: https://github.com/hir4ta/claude-alfred/compare/v0.54.3...v0.54.4
[0.54.3]: https://github.com/hir4ta/claude-alfred/compare/v0.54.2...v0.54.3
[0.54.2]: https://github.com/hir4ta/claude-alfred/compare/v0.54.1...v0.54.2
[0.54.1]: https://github.com/hir4ta/claude-alfred/compare/v0.54.0...v0.54.1
[0.54.0]: https://github.com/hir4ta/claude-alfred/compare/v0.53.0...v0.54.0
[0.53.0]: https://github.com/hir4ta/claude-alfred/compare/v0.52.0...v0.53.0
[0.52.0]: https://github.com/hir4ta/claude-alfred/compare/v0.51.0...v0.52.0
[0.51.0]: https://github.com/hir4ta/claude-alfred/compare/v0.50.0...v0.51.0
[0.50.0]: https://github.com/hir4ta/claude-alfred/compare/v0.49.0...v0.50.0
[0.49.0]: https://github.com/hir4ta/claude-alfred/compare/v0.48.0...v0.49.0
[0.48.0]: https://github.com/hir4ta/claude-alfred/compare/v0.47.0...v0.48.0
[0.47.0]: https://github.com/hir4ta/claude-alfred/compare/v0.46.0...v0.47.0
[0.46.0]: https://github.com/hir4ta/claude-alfred/compare/v0.45.0...v0.46.0
[0.45.0]: https://github.com/hir4ta/claude-alfred/compare/v0.44.0...v0.45.0
[0.44.0]: https://github.com/hir4ta/claude-alfred/compare/v0.43.0...v0.44.0
[0.43.0]: https://github.com/hir4ta/claude-alfred/compare/v0.42.0...v0.43.0
[0.42.0]: https://github.com/hir4ta/claude-alfred/compare/v0.41.0...v0.42.0
[0.41.0]: https://github.com/hir4ta/claude-alfred/compare/v0.40.0...v0.41.0
[0.40.0]: https://github.com/hir4ta/claude-alfred/releases/tag/v0.40.0
