# alfred v1 — Implementation Tasks

## このドキュメントについて

alfred v1 の実装タスクを管理するファイル。
別セッションでも確実に作業を引き継げるよう、背景・方針・各タスクの詳細・進捗を記録する。

### 関連ドキュメント（全て `design/` 内）

| ファイル | 内容 |
|---|---|
| `roadmap.md` | ビジョン、設計原則、アーキテクチャ、Hook/MCP/知識DB/品質スコアの概要設計、実装フェーズ、リサーチ根拠マッピング |
| `detailed-design.md` | Hook 6本の stdin/stdout フロー、gates.json、MCP ツール4アクションのスキーマ、DB Schema V1、状態ファイル、hooks.json/mcp.json 設定 |
| `remaining-design.md` | TUI レイアウト、Rules/Skills/Agents の中身、`alfred init` フロー、CLI コマンド全体、`alfred doctor` |
| `research-ai-code-quality-2026.md` | リサーチ根拠（12 findings + ソース一覧）。全機能がこのリサーチに紐付いている |

---

## 背景と方針

### なぜ v1 か（v0.7 → v1.0）

alfred v0.x の3本柱（Spec, 知識注入, コードレビュー）が全て「情報提示」で止まり、実際の品質改善に貢献できていなかった:
- **Spec**: 儀式化。ドキュメント生成自体が目的に
- **知識注入**: 「なんか出てるけどスルー」。効果不明
- **コードレビュー**: 「形式的にやっている」。品質改善に貢献していない

### v1の本質

**「品質の壁を自動で建てて、Claude Code が自力で乗り越えるのを見守る執事」**

- 壁 > 情報提示（DIRECTIVE > CONTEXT）
- 機械的強制 > 言語的指示（Hook 100% > CLAUDE.md 80%）
- Claude Code の増幅器（ネイティブ Plan/Task をパワーアップ）
- Plugin 不要（`alfred init` で ~/.claude/ に直接配置）
- Voyage AI 100% 前提（FTS5/キーワードフォールバック全削除）
- TUI は残す（品質メトリクス表示に再設計）

### アーキテクチャ

```
alfred = Hook 群 (70%) + 知識 DB (20%) + MCP ツール (10%)

ユーザー → Claude Code → (alfred が裏で監視・注入・ゲート)
                ↓ 必要な時だけ
              alfred MCP (知識 DB)
```

配置:
```
alfred CLI バイナリ (bun build --compile)
  ├── alfred init        → ~/.claude/ に全設定を配置
  ├── alfred mcp         → MCP サーバー (知識 DB のみ)
  ├── alfred hook <event> → Hook ハンドラ (品質チェック実行)
  ├── alfred tui          → TUI 起動
  └── alfred doctor       → ヘルスチェック
```

---

## Phase 0: Gut（削除）

現在のコードベースから v1 の機能を完全削除し、クリーンな状態にする。

### P0-1: Web ダッシュボード削除
- [ ] `web/` ディレクトリ完全削除
- [ ] `src/api/` ディレクトリ完全削除（server.ts, schemas.ts, handlers 全て）
- [ ] package.json から web 関連 devDependencies 削除（vite, react, tanstack, shadcn, tailwind 等）
- [ ] Taskfile から `build:web`, `dev` タスク削除
- [ ] `build.ts` から web ビルド処理削除
- **注意**: `src/api/schemas.ts` は frontend の型定義 source of truth だったが、v1では不要

### P0-2: Spec システム削除
- [ ] `src/spec/` ディレクトリ完全削除（types, init, status, validate, templates, flock 全て）
- [ ] `src/mcp/dossier/` ディレクトリ完全削除（index, helpers, init, lifecycle, crud）
- [ ] `src/hooks/living-spec.ts` 削除
- [ ] `src/hooks/lang-filter.ts` 削除
- [ ] `src/hooks/review-gate.ts` 削除
- [ ] `src/hooks/spec-guard.ts` 削除
- [ ] `src/hooks/drift.ts` 関連ロジック削除（存在すれば）
- [ ] `src/types.ts` から Spec 関連の型定義削除（DecisionEntry, PatternEntry, RuleEntry, SpecTask 等）
- [ ] `.alfred/specs/` テンプレート関連の削除

### P0-3: FTS5 / キーワードフォールバック削除
- [ ] `src/store/fts.ts` から FTS5 関連ロジック削除（knowledge_fts, spec_fts 作成、FTS5 検索関数）
- [ ] `tag_aliases` テーブル関連コード削除
- [ ] `searchKnowledgeKeyword()` 等のキーワードフォールバック関数削除
- [ ] `VOYAGE_API_KEY` の有無分岐ロジック削除（Voyage 必須に）
- [ ] `subTypeHalfLife()` は v1でも使うか検討（recency signal として残す可能性）

### P0-4: 旧知識タイプ削除
- [ ] `src/types.ts` から DecisionEntry, PatternEntry, RuleEntry 削除
- [ ] `VALID_SUB_TYPES` を v1用に更新（error_resolution, exemplar, convention）
- [ ] `src/mcp/ledger.ts` の decision/pattern/rule 固有フィールド処理削除
- [ ] `src/mcp/quality-gate.ts` は構造を大幅に簡素化（重複検出は残す、アクショナビリティチェック見直し）

### P0-5: 旧スキル・エージェント・Plugin 削除
- [ ] `plugin/` ディレクトリ完全削除
- [ ] `plugin/skills/` (brief, attend, tdd, inspect, mend) 全削除
- [ ] `plugin/agents/` (alfred.md, code-reviewer.md) 全削除
- [ ] `plugin/hooks/hooks.json` 削除
- [ ] `plugin/rules/` 削除

### P0-6: Hooks リセット
- [ ] `src/hooks/session-start.ts` — Spec 関連ロジック削除、最小限に
- [ ] `src/hooks/pre-compact.ts` — tasks.json スナップショット削除、auto-complete 削除
- [ ] `src/hooks/user-prompt.ts` — Spec ガード削除、並列 dev ガード削除
- [ ] `src/hooks/post-tool.ts` — Living Spec 削除、Wave 完了検出削除、review-finding 抽出削除
- [ ] `src/hooks/pre-tool.ts` — Review Gate 強制削除、Spec 関連チェック全削除
- [ ] `src/hooks/stop.ts` — Review Gate ブロック削除、Spec 関連チェック削除
- [ ] `src/hooks/directives.ts` — 維持（v1でも使用）
- [ ] `src/hooks/state.ts` — 維持（v1でも使用）
- [ ] `src/hooks/dispatcher.ts` — 維持（v1でも使用、イベントハンドラ接続更新）

### P0-7: DB スキーマ準備
- [ ] `src/store/schema.ts` — spec_index, spec_fts, knowledge_fts, tag_aliases の CREATE TABLE 削除
- [ ] FTS5 トリガー削除
- [ ] `spec-sync.ts` 削除
- [ ] `src/store/knowledge.ts` — Spec 関連の結合クエリ削除

### P0-8: CLAUDE.md / Rules 更新
- [ ] プロジェクト CLAUDE.md を v1用に大幅書き直し（Spec 関連セクション全削除、v1アーキテクチャ記載）
- [ ] `.claude/rules/` から v1 固有ルール削除（spec-details.md, implementation-discipline.md, hook-behavior.md のうち Spec 関連部分、frontend.md, butler-design.md）
- [ ] `.claude/rules/` に v1用ルール追加（必要に応じて）

### P0-9: ビルド確認
- [ ] `bun build.ts` が通ること確認
- [ ] `tsc --noEmit` が通ること確認
- [ ] 既存テストの中で Spec/FTS5/Dashboard に依存するものを削除 or 更新
- [ ] `vitest` が通ること確認

---

## Phase 1: Foundation（基盤構築）

削除後のクリーンなコードベースに v1の基盤を構築。

### P1-1: DB Schema V1
- [ ] `src/store/schema.ts` を V1 に更新
  - `knowledge_index` テーブル再設計（type カラム: error_resolution/exemplar/convention）
  - `quality_events` テーブル新規作成
  - `spec_index`, `spec_fts`, `knowledge_fts`, `tag_aliases` テーブル削除
  - `embeddings` テーブルは source='knowledge' のみに（'spec' 削除）
- [ ] `rebuildFromScratch` マイグレーション実装（full reset）
- [ ] `src/store/knowledge.ts` を v1知識タイプ用にリライト
  - `upsertKnowledge()` — error_resolution/exemplar/convention 対応
  - `searchKnowledge()` — Voyage only（FTS5 フォールバック削除）
- [ ] `src/store/quality-events.ts` 新規作成
  - `insertQualityEvent()`
  - `getSessionSummary(session_id)`
  - `getQualityScore(session_id)`
- [ ] テスト: Schema V1 の CRUD テスト

### P1-2: Voyage Only 検索パイプライン
- [ ] `src/store/fts.ts` → `src/store/search.ts` にリネーム・リライト
  - Voyage vector search → rerank → recency → hit_count の一本道
  - FTS5 フォールバック完全削除
  - `searchPipeline()` を Voyage 必須に
- [ ] `src/embedder/` は基本維持（voyage-4-large, rerank-2.5）
- [ ] VOYAGE_API_KEY なし時のエラーハンドリング（起動時に明確なエラーメッセージ）
- [ ] テスト: ベクトル検索のテスト

### P1-3: MCP ツール `alfred` (1 ツール)
- [ ] `src/mcp/server.ts` リライト — dossier + ledger → `alfred` 1 ツール
- [ ] `src/mcp/alfred-tool.ts` 新規作成
  - `action=search` — Voyage ベクトル検索（type フィルタ、scope 対応）
  - `action=save` — 知識保存（品質ゲート + DB upsert + Voyage embed）
  - `action=profile` — プロジェクトプロファイル表示/更新
  - `action=score` — 品質スコア算出・表示
- [ ] `src/mcp/quality-gate.ts` 簡素化 — 重複検出は維持、Spec 関連削除
- [ ] Zod スキーマ定義（各アクションの入力バリデーション）
- [ ] テスト: 各アクションのユニットテスト

### P1-4: プロジェクトプロファイリング
- [ ] `src/profile/` 新規作成
  - `detectProfile(cwd)` — package.json, tsconfig.json, biome.json, Taskfile 等からプロファイル生成
  - `detectGates(cwd)` — プロファイルから gates.json を自動生成
- [ ] `.alfred/.state/project-profile.json` の読み書き
- [ ] テスト: 各種プロジェクト構成でのプロファイル検出テスト

### P1-5: gates.json フレームワーク
- [ ] `src/gates/` 新規作成
  - `loadGates(cwd)` — .alfred/gates.json 読み込み + キャッシュ
  - `runGate(gate, file?, timeout)` — 個別ゲート実行（Bash spawn + タイムアウト）
  - `runGateGroup(group, file?)` — on_write / on_commit グループ実行
- [ ] `{file}` プレースホルダー置換
- [ ] `run_once_per_batch` フラグ対応
- [ ] fail-open: タイムアウト時はスキップ
- [ ] テスト: ゲート実行のテスト（モック）

### P1-6: `alfred init` コマンド
- [ ] `src/cli.ts` に `init` サブコマンド追加
  - `--scan` オプション
  - `--force` オプション
- [ ] `src/init/` 新規作成
  - `installMcp()` — ~/.claude/.mcp.json に alfred エントリ追加
  - `installHooks()` — ~/.claude/settings.json に 6 hooks 追加（既存マージ）
  - `installRules()` — ~/.claude/rules/alfred-quality.md 配置
  - `installSkills()` — ~/.claude/skills/alfred-review/, alfred-conventions/ 配置
  - `installAgents()` — ~/.claude/agents/alfred-reviewer.md 配置
  - `initProject()` — .alfred/.state/ 作成、gates.json 生成、conventions.json 初期化
  - `initDb()` — ~/.alfred/alfred.db に Schema V1 作成
- [ ] Skills/Agents/Rules のコンテンツは `src/init/templates/` に埋め込み
- [ ] テスト: init のテスト（tmpdir で実行）

### P1-7: `alfred uninstall` コマンド
- [ ] `src/cli.ts` に `uninstall` サブコマンド追加
  - `--keep-data` オプション
- [ ] 各設定ファイルからの alfred エントリ削除

---

## Phase 2: Walls（壁の実装）

品質の壁を Hook として実装する。alfred の価値の大部分がここ。

### P2-1: PostToolUse リライト（最重要）
- [ ] `src/hooks/post-tool.ts` を完全リライト
- [ ] Edit/Write 後: gates.json の on_write ゲート実行 → pending-fixes.json 更新 → DIRECTIVE 注入
- [ ] Bash 後 (テスト実行検出): テスト結果パース → pass/fail 判定 → error_resolution 検索 → 注入
- [ ] Bash 後 (テスト成功): アサーション品質チェック (密度 < 2 → WARNING)
- [ ] Bash 後 (git commit 検出): on_commit ゲート実行 → DIRECTIVE
- [ ] Bash エラー: error_resolution ベクトル検索 → ヒット時 CONTEXT 注入
- [ ] タスク完了検出: Self-reflection DIRECTIVE 注入（4点チェック）
- [ ] quality_event 記録（全てのゲート結果）
- [ ] テスト: 各フローのテスト

### P2-2: PreToolUse リライト
- [ ] `src/hooks/pre-tool.ts` を完全リライト
- [ ] pending-fixes.json チェック → 未修正エラーあり → exit 2 (DENY)
- [ ] convention チェック → 対象ファイルの convention を CONTEXT 注入
- [ ] テスト隣接チェック → 対応テストなし → WARNING
- [ ] テスト: DENY/ALLOW の各パターン

### P2-3: UserPromptSubmit リライト
- [ ] `src/hooks/user-prompt.ts` を完全リライト
- [ ] Plan mode 検出 → テスト先行 + 受け入れ基準を **DIRECTIVE** 注入
- [ ] 実装系プロンプト → error_resolution + exemplar をベクトル検索 → CONTEXT 注入
- [ ] convention 矛盾チェック → WARNING
- [ ] テスト: 各パターンのテスト

### P2-4: SessionStart リライト
- [ ] `src/hooks/session-start.ts` を完全リライト
- [ ] プロジェクトプロファイル確認/初回生成
- [ ] 前セッション品質サマリー注入
- [ ] conventions 注入（最大5件）
- [ ] 知識同期（.alfred/knowledge/ → DB）
- [ ] テスト

### P2-5: pending-fixes.json の管理
- [ ] `src/hooks/pending-fixes.ts` 新規作成
  - `readPendingFixes(cwd)` — 読み込み
  - `writePendingFixes(cwd, fixes)` — 書き込み
  - `clearPendingFixes(cwd)` — クリア
  - `hasPendingFixes(cwd)` — 未修正エラーあり判定
- [ ] PostToolUse で書き込み、PreToolUse で読み込みのフロー確認

### P2-6: error_resolution 自動蓄積
- [ ] PostToolUse: Bash エラー後に修正成功を検出するロジック
  - エラーの stderr/stdout を `.alfred/.state/last-error.json` に保存
  - 次の Bash 成功時に `last-error.json` を確認 → ペアを error_resolution として保存
- [ ] PreCompact: セッション中の error_resolution を一括抽出（agent hook）

---

## Phase 3: Intelligence（知性）

壁を賢くする知識システムと、深掘りレビュー。

### P3-1: error_resolution ベクトル検索 + 自動注入
- [ ] PostToolUse Bash エラー時に Voyage ベクトル検索 → ヒット時 CONTEXT 注入
- [ ] error_signature の正規化ロジック（パス・行番号・変数名を除去）
- [ ] ヒット率を quality_event に記録

### P3-2: exemplar 蓄積 + 注入
- [ ] MCP `alfred save type=exemplar` — bad/good/explanation の構造化保存
- [ ] UserPromptSubmit: 実装系プロンプト時に関連 exemplar をベクトル検索 → 注入
- [ ] /alfred:review の findings 確定時に fix diff から自動 exemplar 生成（Phase 3+）

### P3-3: /alfred:review スキル実装
- [ ] `~/.claude/skills/alfred-review/SKILL.md` の内容確定・配置
- [ ] `~/.claude/skills/alfred-review/checklists/` の各チェックリスト作成
  - security.md, logic.md, design.md, judge.md
- [ ] `~/.claude/agents/alfred-reviewer.md` 配置
- [ ] Judge Agent パターンの Phase 3 実装（findings フィルタリング）

### P3-4: /alfred:conventions スキル実装
- [ ] `~/.claude/skills/alfred-conventions/SKILL.md` の内容確定・配置
- [ ] convention 発見ロジック（import 順序、命名、エラーハンドリング、テスト構造、ディレクトリ）
- [ ] 確認された convention → .alfred/conventions.json + .claude/rules/alfred-conventions.md 生成

### P3-5: 品質スコア算出
- [ ] `src/store/quality-events.ts` に `calculateQualityScore()` 実装
  - gate_pass_rate_write (30%), test_coverage_delta (25%), gate_pass_rate_commit (20%), error_resolution_hit (15%), convention_adherence (10%)
- [ ] MCP `alfred action=score` 実装
- [ ] SessionStart で前セッションスコアを CONTEXT 注入

---

## Phase 4: Polish（磨き）

### P4-1: TUI 再設計
- [ ] `src/tui/` をリライト — 品質ダッシュボードに
- [ ] Quality Score セクション
- [ ] Gates セクション (on_write / on_commit / test の pass/fail/rate)
- [ ] Knowledge セクション (error_resolution ヒット率、exemplar 注入数、convention 遵守率)
- [ ] Recent Events セクション (リアルタイムストリーム)
- [ ] Gruvbox Material Dark パレット維持

### P4-2: PreCompact リライト
- [ ] chapter memory（作業状態を .alfred/.state/chapter.json に保存）
- [ ] 品質サマリー計算・保存
- [ ] Agent hook: 意思決定抽出（error_resolution 形式で保存）

### P4-3: Stop リライト
- [ ] 未テスト変更ファイルチェック → CONTEXT
- [ ] pending-fixes チェック → WARNING
- [ ] 品質サマリー最終保存

### P4-4: alfred doctor 更新
- [ ] v1用のヘルスチェック項目に更新
  - Binary, DB, MCP, Hooks, Rules, Skills, Agent, Voyage AI, Project, Conventions, Knowledge

### P4-5: Zero-config 初回セットアップ
- [ ] SessionStart で .alfred/ 未存在時に自動 `alfred init` 相当を実行
- [ ] プロジェクトプロファイリング自動実行

### P4-6: バックグラウンド品質スキャン
- [ ] `alfred scan` コマンド — コードベース全体の lint/type/test を実行、品質スコア更新
- [ ] cron/schedule での定期実行対応

### P4-7: クロスプロジェクト学習
- [ ] MCP `alfred search scope=global` — 全プロジェクト横断検索
- [ ] 3+ プロジェクトで確認されたパターン → universal タグ

---

## 進捗サマリー

| Phase | 状態 | タスク数 | 完了 |
|---|---|---|---|
| Phase 0: Gut | **完了** | 9 | 9/9 |
| Phase 1: Foundation | **完了** | 7 | 7/7 |
| Phase 2: Walls | **完了** | 6 | 6/6 |
| Phase 3: Intelligence | 未着手 | 5 | 0/5 |
| Phase 4: Polish | 未着手 | 7 | 0/7 |
| **合計** | | **34** | **22/34** |

---

## セッション引き継ぎノート

### 現在の状態 (2026-03-26)
- **Phase 0 + Phase 1 + Phase 2 完了** — tsc + build + vitest 全パス (116テスト)
- 設計ドキュメントは `design/` に全て格納

### Phase 2 完了サマリー
- P2-1: PostToolUse リライト (`src/hooks/post-tool.ts`) — Edit/Write→on_write ゲート実行→pending-fixes→DIRECTIVE、Bash→テスト検出+git commit検出+エラー検出、Self-reflection注入、quality_event記録
- P2-2: PreToolUse リライト (`src/hooks/pre-tool.ts`) — pending-fixes チェック→DENY、テスト隣接チェック→WARNING
- P2-3: UserPromptSubmit リライト (`src/hooks/user-prompt.ts`) — スコアリングベース意図分類（排除+実装スコア比較、位置重み、否定ハンドリング）、Plan mode→DIRECTIVE、大タスク→WARNING
- P2-4: SessionStart リライト (`src/hooks/session-start.ts`) — プロファイル確認/生成、前セッション品質サマリー注入、conventions注入、gates自動生成
- P2-5: pending-fixes管理 (`src/hooks/pending-fixes.ts`) — read/write/clear/has/format/parse
- P2-6: error_resolution自動蓄積 — last-error.json ペアリング（PostToolUse内）
- Stop/PreCompact も最低限実装（pending-fixes WARNING、品質サマリー保存）
- 検出ヘルパー分離 (`src/hooks/detect.ts`) — isGitCommit, isTestCommand, isSourceFile, guessTestFile 等（vitest互換）
- キーワード: EN+JP 95個のIMPLキーワード、70個の除外キーワード、35個の大タスクシグナル、包括的テストコマンド検出
- テスト: 28→116（+88テスト）

### Phase 1 完了サマリー
- P1-1: DB Schema V1 (projects, knowledge_index, embeddings, quality_events) — FTS5完全削除、v0互換型削除
- P1-2: Voyage only 検索パイプライン (`src/store/search.ts`) — vector search → rerank → recency → hit_count
- P1-3: MCP ツール `alfred` 実装 (`src/mcp/alfred-tool.ts`) — search/save/profile/score の4アクション
- P1-4: プロジェクトプロファイリング (`src/profile/detect.ts`) — 言語/テストFW/リンター/ビルドシステム自動検出
- P1-5: gates.json フレームワーク (`src/gates/index.ts`) — load/run/detect + 自動検出
- P1-6: `alfred init` (`src/init/index.ts`) — MCP/hooks/rules/skills/agents/gates/profile/DB 一括セットアップ
- P1-7: `alfred uninstall` (CLI) — クリーンアンインストール

### 次のアクション
- Phase 3 (Intelligence) から開始
- P3-1 (error_resolution ベクトル検索 + 自動注入) から着手

### 重要な設計判断（覚えておくべき）
1. **Plugin 不要** — `alfred init` で ~/.claude/ に直接配置
2. **PostToolUse はブロック不可** — 二段構え（PostToolUse で検出 → PreToolUse で DENY）
3. **知識タイプは3種のみ** — error_resolution, exemplar, convention（+ quality_event はログ）
4. **MCP は 1 ツール 4 アクション** — search, save, profile, score
5. **UserPromptSubmit の Plan 検出は DIRECTIVE** — テスト先行を強制
6. **Voyage AI 100% 前提** — FTS5 フォールバックなし
7. **DB は ~/.alfred/alfred.db** — プロジェクト横断
8. **リサーチ根拠 12 findings** — 全機能が research-ai-code-quality-2026.md に紐付く
9. **意図分類はスコアリングベース** — 二値keyword matchではなく、位置重み+排除/実装スコア比較。外部NLPライブラリは不要（リサーチ済み: compromise/nlpjs/bayesはこのユースケースで keyword list より優位性なし）
10. **検出ヘルパーは detect.ts に分離** — bun:sqlite非依存で vitest テスト可能
