# Changelog

All notable changes to claude-alfred are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.57.0] - 2026-03-08

### Added
- `alfred status` コマンド — DB統計、APIキー状態、アクティブタスク、パス情報をリッチ表示
- `alfred settings` コマンド — 対話型TUIでAPIキー管理（シェルプロファイル永続化）
- `alfred init` にAPIキー入力プロンプト追加（未設定時に対話的に入力、EscでFTS-onlyモード選択可）
- `Store.CountEmbeddings()` メソッド追加
- `envFloat` に範囲バリデーション [0,1] + parseエラーログ追加

### Fixed
- `isClaudeConfigPath` の `.claude/` 部分文字列マッチを `/.claude/` に修正（`myclaude/` 誤マッチ防止）
- marketplace.json バージョン不整合 (0.55.0 → 0.57.0 に同期)
- settings.local.json から不要な Supabase 権限削除
- configure スキルに `context: current` 明示（plan との一貫性）

### Changed
- `alfred init` が VOYAGE_API_KEY 未設定でもFTS-onlyモードで動作可能に
- チャネル同期に `atomic.Bool` による安全なdouble-close防止

## [0.56.1] - 2026-03-08

### Added
- 永続メモリ機能（source_type="memory", TTL=0）
- recall MCP tool（memory特化の検索・保存）
- Stop hook: セッション要約をmemory永続化
- 非同期embedding（spec/memory docs）
- FTS日本語対応（kagome IPA辞書）

### Fixed
- plugin.json 重複 hooks フィールド削除

## [0.55.0] - 2026-03-08

### Fixed
- **[Critical]** `reviewHandler` に `validateProjectPath` 追加（パストラバーサル脆弱性修正）
- **[Critical]** `ingestProjectClaudeMD` の `UpsertDoc` 戻り値キャプチャ（エラー完全破棄を修正）
- `PRAGMA user_version` Scan エラーのログ出力追加（silent fallback 解消）
- `downloadRelease` の `os.Getenv("HOME")` → `os.UserHomeDir()` に統一
- `removeOldestCompactMarker` のコメント修正（ロジックは正しかった）

### Changed
- Schema migration を `BEGIN/COMMIT` トランザクションで原子化（`execer` interface 導入）
- `DeleteDocsByURLPrefix` / `DeleteExpiredDocs` をトランザクションで原子化
- spec ツール: `DestructiveHintAnnotation` 削除（action 粒度で description 内に明記）
- spec ツール: `project_path` から `Required()` 削除（description との矛盾解消）
- brainstorm/refine/plan: `WebSearch`/`WebFetch` 削除（curated knowledge 方針統一）
- brainstorm/refine: `disable-model-invocation: true` 追加（自動起動防止）
- configure/setup/refine: 未定義の `context: current` 削除
- alfred-protocol rule: `globs: .alfred/**` 追加（条件付きロード）
- alfred agent: `memory: user` → `memory: project`（マルチプロジェクト汚染防止）
- plugin.json: `hooks` フィールド追加（auto-discovery 依存からマニフェスト明示へ）
- 空の `settings.json` 削除（バンドル時に自動生成）

## [0.54.4] - 2026-03-08

### Fixed
- `rows.Err()` チェック追加（docs.go 2箇所 + vectors.go 1箇所）— ループ中の I/O エラー検出漏れ修正
- `RowsAffected()` エラー伝搬（DeleteDocsByURLPrefix）
- Rerank API エラーを `voyageError` 型に統一（401/403 時の API key マスク対応）
- configure スキルの実装ギャップ修正（存在しない Explore agent 参照、未実装 constraint tags 参照）
- Debug log パーミッション 0644 → 0600（world-readable 解消）
- UpsertDoc の `_` エラー無視に理由コメント追加（go-errors ルール準拠）

### Changed
- `handleSessionStart` で ctx を `ingestProjectClaudeMD` に伝搬（将来の context-aware 拡張に備え）
- `handleUserPromptSubmit` の未使用 ctx を `_ context.Context` パラメータに変更（Go イディオム準拠）
- CLAUDE.md に `## Compact Instructions` セクション追加

## [0.54.3] - 2026-03-08

### Changed
- PreToolUse matcher を `Edit|Write` に最小権限化（`Read` 除外で不要な発火を削減）
- run.sh の SHA256 checksum 検証を必須化（ダウンロード失敗時は exit 1）
- Hook handler に event 別 `context.WithTimeout` を追加（外部 timeout 前の graceful cleanup）
- PreCompact の DB sync を hook context 経由に統一

### Added
- `store.DebugLog` callback — store 層の scan error を debug ログに出力（3箇所）
- release スキルに `disable-model-invocation: true`（Claude による自動リリース防止）

## [0.54.2] - 2026-03-08

### Changed
- spec ツール `DestructiveHintAnnotation` を `true` に修正（delete アクションは destructive）
- Skills/Agents の Bash 権限を最小化: review/setup/release/code-reviewer
- PreToolUse matcher を `Read|Edit|Write` に絞り込み（Glob|Grep 除外）
- PreToolUse timeout 3s → 2s（公式推奨 <2s に準拠）
- alfred-protocol ルールをグローバル化（`.alfred/**` paths 制限を撤廃）
- MCP ツール名を `mcp__plugin_alfred_alfred__*` フルネームに統一
- settings.json から冗長な model 定義を削除（agents frontmatter が正）

## [0.54.1] - 2026-03-08

### Fixed
- plugin.json から未サポートの `category` フィールドを削除（プラグインバリデーションエラー修正）

## [0.54.0] - 2026-03-08

### Changed
- Graceful degradation: stderr warnings on store/DB open failures (hooks_session, hooks_compact)
- Voyage API 401/403 error masking to prevent API key leakage in logs
- `ambiguousKeywords` DRY refactor: generated from `frameworkFamilies` table
- Spec tool annotation: `destructiveHint: false` (status is read-only)
- PreToolUse hook matcher expanded: `Read|Edit|Write|Glob|Grep`
- Skills全面改善: plan (slug validation), brainstorm (query guidance), refine (flexible templates), review (git diff guidance), setup (stack defaults), configure (hook types updated)
- Agents改善: code-reviewer (spec-less fallback), alfred (Write/Edit usage clarified)
- Rules改善: alfred-protocol (Compact Marker format), alfred (spec tool docs)

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

[Unreleased]: https://github.com/hir4ta/claude-alfred/compare/v0.57.0...HEAD
[0.57.0]: https://github.com/hir4ta/claude-alfred/compare/v0.56.1...v0.57.0
[0.56.1]: https://github.com/hir4ta/claude-alfred/compare/v0.55.0...v0.56.1
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
