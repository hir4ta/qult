# alfred v1: Claude Code Quality Amplifier

## ビジョン

**alfred は Claude Code の増幅器。Claude Code のネイティブ機能（Plan, Task, Sub-agent, Bash 等）をパワーアップし、品質を限界まで引き出す。**

alfred は独自のワークフローを持たない。Claude Code の行動を監視し、品質の壁を自動で建て、Claude Code が自力で乗り越えるのを見守る。

```
ユーザー → Claude Code → (alfred が裏で監視・注入・ゲート)
                ↓ 必要な時だけ
              alfred MCP (知識 DB)
```

### 設計原則

1. **壁 > 情報提示** — 「提案」ではなく「物理的な壁」を置く
2. **機械的強制 > 言語的指示** — CLAUDE.md ルール(80%遵守) ではなく Hook DIRECTIVE(100%強制)
3. **Claude Code 増幅 > 代替** — Plan mode, Task tracking 等のネイティブ機能をパワーアップ
4. **リサーチ駆動** — 効果が実証された手法のみ実装
5. **不可視** — ユーザーは alfred を意識しない。Claude Code も必要な時だけ呼ぶ

### 比重

| 比重 | 役割 |
|---|---|
| **70%** | Hook（監視 + コンテキスト注入 + ゲート） |
| **20%** | DB + ベクトル検索（壁を賢くするデータ） |
| **10%** | MCP ツール（Claude Code が呼ぶインターフェース） |

---

## 完全削除

| 対象 | 理由 |
|---|---|
| Web ダッシュボード (`web/`, `src/api/`) | 品質ハーネスに不要 |
| Spec システム (`src/spec/`) | 儀式。Claude Code の Plan mode をパワーアップする |
| Living Spec (`src/hooks/living-spec.ts`) | Spec 削除 |
| Drift 検出 | Spec なしでは参照点なし。convention チェックに置換 |
| Review Gate ハード強制 (`review-gate.json`, `fix_mode`) | ソフト CONTEXT に置換 |
| FTS5 全体 (`knowledge_fts`, `spec_fts`, `tag_aliases`) | Voyage AI 100%前提 |
| キーワードフォールバック | 同上 |
| Spec DB テーブル (`spec_index`, `spec_fts`) | Spec 削除 |
| 現在の知識タイプ (decision, pattern, rule) | 「情報提示」型。壁として機能していなかった |
| `/alfred:brief`, `/alfred:attend`, `/alfred:inspect`, `/alfred:mend` | Spec 前提スキル |

---

## アーキテクチャ

```
alfred = Hook 群 (品質の壁) + 知識 DB (壁を賢くする) + TUI (壁の効果を可視化)
```

### データフロー

```
Claude Code がコードを書く
  ↓
PostToolUse Hook が検出
  ↓
壁チェック (lint/type/test/convention)
  ↓ fail
DIRECTIVE 注入 → Claude Code が修正
  ↓ pass
次のアクションへ

Claude Code がエラーに遭遇
  ↓
PostToolUse Hook が検出
  ↓
知識 DB でベクトル検索 (error_resolution)
  ↓ hit
解決策を CONTEXT 注入 → Claude Code が適用
  ↓ miss
通常のデバッグフローへ (解決後に自動保存)
```

---

## Hook 設計（リサーチ根拠付き）

### PostToolUse (5s) — 最重要 Hook

行動の直後に壁を置く。alfred の価値の大部分がここに集中。

| トリガー | 壁 | 種別 | 根拠 |
|---|---|---|---|
| Write/Edit でソースファイル変更 | `tsc --noEmit` + `biome check` 実行 → fail で DIRECTIVE | ゲート | #2 静的解析ループ: セキュリティ40%→13%, 可読性80%→11% |
| Write/Edit でソースファイル変更 | 対応テストファイルなし → DIRECTIVE | ゲート | #1 テストが #1 レバレッジ (Anthropic公式) |
| Bash 成功 + テストコマンド検出 | 結果パース → fail で過去の解決策検索・注入 | 注入 | #10 エラー解決キャッシュ |
| Bash 成功 + テストコマンド成功 | アサーション品質チェック (密度<2 → WARNING) | ゲート | #12 サイレント障害検出 |
| Bash エラー | ベクトル検索 → 過去の解決策注入 | 注入 | #10 エラー解決キャッシュ |
| git commit 検出 | `vitest --changed` 実行 → fail で DIRECTIVE | ゲート | #1 テスト |
| git commit 検出 | gates.json のチェック群実行 → fail で DIRECTIVE | ゲート | #3 機械的強制 (OpenAI) |
| タスク完了検出 | Self-reflection DIRECTIVE (4点チェック) | ゲート | #5 Self-reflection: 80%→91% |
| 長時間経過検出 (35分目安) | 分割 DIRECTIVE | ゲート | #7 タスク時間2x = 失敗率4x |
| Write/Edit 後 lint 同一エラー 3回 | fix パターンを DIRECTIVE 提示 | 注入 | #10 エラー解決キャッシュ |

### UserPromptSubmit (10s) — Plan mode パワーアップ

| トリガー | アクション | 種別 | 根拠 |
|---|---|---|---|
| Plan mode / 実装計画検出 | 「テスト先行」「受け入れ基準」を **DIRECTIVE** で注入 | ゲート | #4 SDD+TDD: リグレッション70%削減 |
| 実装系プロンプト | 関連 error_resolution + exemplar をピンポイント注入 | 注入 | #8 Few-shot > ルールリスト, #10 エラー解決 |
| プロンプトが convention に矛盾 | WARNING | ゲート | #3 機械的強制 |

### PreToolUse (3s) — 軽量ゲート

| トリガー | アクション | 種別 | 根拠 |
|---|---|---|---|
| Write/Edit 対象ファイル | convention チェック → CONTEXT | 注入 | #8 Few-shot 正規例 |

### PreCompact (10s) — コンテキスト管理

| トリガー | アクション | 種別 | 根拠 |
|---|---|---|---|
| コンパクション発生 | セッション中の error_resolution を自動抽出・保存 | 学習 | #10 エラー解決キャッシュ |
| コンパクション発生 | 品質サマリー (壁の通過/失敗カウント) を保存 | 記録 | 効果測定 |
| トークン推定 60K | chapter close + 継続プロンプト | 管理 | #6 コンテキスト腐敗 80K-150K |

### SessionStart (5s) — 初期コンテキスト

| トリガー | アクション | 種別 | 根拠 |
|---|---|---|---|
| セッション開始 | プロジェクトプロファイル注入 (言語, テストFW, リンター) | 注入 | 壁を適切に設定するため |
| セッション開始 | 前セッションの品質サマリー注入 | 注入 | #5 Self-reflection (セッション単位) |
| 初回セッション | プロジェクト自動プロファイリング | 設定 | Zero-config |
| セッション開始 | conventions 注入 | 注入 | #3 機械的強制 |

### Stop (3s) — 最終チェック

| トリガー | アクション | 種別 | 根拠 |
|---|---|---|---|
| セッション終了 | 未テストの変更ファイル → CONTEXT | リマインダー | #1 テスト |
| セッション終了 | 品質サマリー計算・保存 | 記録 | 効果測定 |

---

## 知識 DB（壁を賢くするデータ）

### 知識タイプ（4種のみ）

| タイプ | 目的 | 壁としての使われ方 | 根拠 |
|---|---|---|---|
| **error_resolution** | エラー→解決策のキャッシュ | Bash エラー時に即注入 | #10 |
| **exemplar** | before/after コード例 | コード書き込み時に関連例を注入 | #8 Few-shot > ルールリスト |
| **convention** | プロジェクト規約 | PreToolUse で convention チェック | #3 機械的強制 |
| **quality_event** | 品質イベントログ | TUI 表示 + セッション品質スコア | #5 効果測定 |

### 検索パイプライン（Voyage only）

```
Voyage vector search → rerank → recency signal → hit_count tracking
```

FTS5, キーワードフォールバック, tag_aliases は全て削除。

### 蓄積メカニズム

- **error_resolution**: PostToolUse でエラー→修正の対を自動検出・保存。PreCompact でセッション中の解決を一括抽出
- **exemplar**: レビューで確定した fix diff から自動生成。手動保存も可能
- **convention**: `/alfred:conventions` スキルで自動マイニング or 手動登録
- **quality_event**: Hook が壁チェック結果を自動記録

### DB スキーマ (V1)

```sql
-- 維持
projects (id, name, remote, path, status, ...)
embeddings (id, source, source_id, model, dims, vector, created_at)

-- 再設計
knowledge_index (
  id, project_id FK, type ENUM('error_resolution','exemplar','convention'),
  title, content JSON, tags, author,
  hit_count, last_accessed, enabled,
  created_at, updated_at
)

-- 新規
quality_events (
  id, project_id FK, session_id,
  event_type ENUM('gate_pass','gate_fail','error_hit','error_miss','review_finding'),
  data JSON, created_at
)

-- 削除
spec_index, spec_fts, knowledge_fts, tag_aliases, schema_version migration
```

---

## MCP ツール（最小構成）

### `alfred` — 1 ツール

```
alfred action=search query="..." [type=error_resolution|exemplar|convention] [scope=project|global]
alfred action=save type=error_resolution|exemplar|convention title="..." content={...}
alfred action=profile [refresh=true]
alfred action=score [session_id=...]
```

- **search**: Voyage ベクトル検索。Claude Code が「前にこのエラー見た？」時に呼ぶ
- **save**: 知識保存。Hook が DIRECTIVE で Claude Code に保存を促すケースが多い
- **profile**: プロジェクトプロファイル表示/更新
- **score**: 品質スコア表示

---

## CI スタイルゲート (`.alfred/gates.json`)

```json
{
  "on_write": {
    "typecheck": "tsc --noEmit",
    "lint": "biome check --no-errors-on-unmatched"
  },
  "on_commit": {
    "test_changed": "vitest --changed --reporter=verbose",
    "typecheck": "tsc --noEmit"
  }
}
```

- プロジェクトの package.json / Taskfile / Makefile から自動検出してデフォルト生成
- `on_write`: PostToolUse Write/Edit 後に実行
- `on_commit`: PostToolUse git commit 後に実行
- 全て fail → DIRECTIVE。Claude Code が修正するまで壁として機能
- ユーザーがカスタマイズ可能

---

## Self-Reflection プロトコル

PostToolUse でタスク完了を検出した時に DIRECTIVE として注入:

```
Before marking this complete, verify:
1. Edge cases — List 3 edge cases. Are they handled or tested?
2. Silent failure — Could this produce wrong output without crashing? How would you know?
3. Simplicity — Is there a simpler way to achieve the same result?
4. Conventions — Does this match the project's established patterns?
```

根拠: Self-reflection で HumanEval 80% → 91% (Finding #5)

---

## Skills（最小構成）

| スキル | 目的 | 備考 |
|---|---|---|
| `/alfred:review` | Deep マルチエージェントレビュー | Judge Agent で findings 選別。必要な時だけ呼ぶ（毎回ではない） |
| `/alfred:conventions` | コードベースから convention 自動発見 | プロジェクト初回 or リファクタ後に実行 |

- `/alfred:brief`, `/alfred:attend`, `/alfred:inspect`, `/alfred:mend`, `/alfred:tdd` は全て削除
- レビューは「壁」(Hook) が日常、「深掘り」(skill) が例外
- TDD は Hook の壁（テスト先行 DIRECTIVE）で自然に実現

---

## TUI（内容は別途設計）

品質の壁の効果を可視化する。候補:

- リアルタイム壁チェック結果 (pass/fail ストリーム)
- セッション品質スコア
- error_resolution ヒット率（知識が実際に使われているか）
- convention 遵守率
- テストカバレッジ推移

詳細設計は実装フェーズで決定。

---

## 品質スコア

セッション単位で算出。SessionStart で前セッンスコアを注入。

| コンポーネント | 重み | 測定方法 |
|---|---|---|
| 壁通過率 (on_write) | 30% | gate_pass / (gate_pass + gate_fail) |
| テストカバレッジ delta | 25% | テスト実行結果から |
| 壁通過率 (on_commit) | 20% | gate_pass / (gate_pass + gate_fail) |
| error_resolution ヒット率 | 15% | error_hit / (error_hit + error_miss) |
| convention 遵守率 | 10% | convention チェック pass 率 |

---

## 実装フェーズ

### Phase 0: Gut（削除）

全削除を先にやる。コードベースをクリーンにしてから構築。

- Web ダッシュボード削除 (`web/`, `src/api/`)
- Spec システム削除 (`src/spec/`)
- Living Spec, Drift, Review Gate 削除
- FTS5 全体削除
- 現在の知識タイプ (decision/pattern/rule) 削除
- 旧スキル削除
- DB テーブル削除 (spec_index, spec_fts, tag_aliases)
- CLAUDE.md / rules 更新

### Phase 1: Foundation

- Schema V1 (rebuildFromScratch)
- MCP ツール `alfred` (search/save/profile/score)
- プロジェクトプロファイリング（言語/テストFW/リンター自動検出）
- `.alfred/gates.json` + 自動生成
- Voyage only 検索パイプライン

### Phase 2: Walls (壁)

- PostToolUse リライト: lint/type ゲート、テスト先行チェック、コミットゲート
- UserPromptSubmit リライト: Plan mode パワーアップ、exemplar 注入
- PreToolUse リライト: convention チェック
- Self-reflection プロトコル
- error_resolution 自動蓄積（Bash エラー→修正検出）

### Phase 3: Intelligence

- error_resolution ベクトル検索 + 自動注入
- exemplar 蓄積 + 注入
- `/alfred:review` スキル（Judge Agent パターン）
- `/alfred:conventions` スキル
- 品質スコア算出

### Phase 4: Polish

- TUI 再設計
- PreCompact: chapter memory + 品質サマリー
- SessionStart: 品質スコア注入
- Stop: 最終チェック
- Zero-config 初回セットアップ
- クロスプロジェクト学習
- バックグラウンド品質スキャン (`alfred scan` — cron/schedule でコードベース全体の lint/type/test を定期実行、品質スコア更新。OpenAI のエントロピー管理に相当)

---

## リサーチ根拠マッピング

全機能が `research-ai-code-quality-2026.md` の findings に紐付いている:

| Finding # | 内容 | 効果 | alfred 実装 |
|---|---|---|---|
| #1 | テスト/期待出力 = #1 レバレッジ | Anthropic 公式 | テスト先行 DIRECTIVE, コミット時テスト実行 |
| #2 | 静的解析フィードバックループ | セキュリティ40%→13%, 可読性80%→11% | on_write ゲート (lint/type) |
| #3 | 機械的強制 > 言語的指示 | OpenAI 1Mライン実績 | 全ゲートを Hook DIRECTIVE 化 |
| #4 | SDD+TDD 組み合わせ | リグレッション70%削減 | Plan mode に TDD 注入 |
| #5 | Self-reflection | HumanEval 80%→91% | タスク完了時 Self-reflection DIRECTIVE |
| #6 | コンテキスト腐敗 80K-150K | 企業AI障害65% | 60K で chapter close |
| #7 | タスク時間 2x = 失敗率 4x | 35分閾値 | 長時間タスク分割 DIRECTIVE |
| #8 | Few-shot 正規例 > ルールリスト | Anthropic 推奨 | exemplar 注入 |
| #9 | Judge Agent パターン | HubSpot 80%承認率 | /alfred:review の findings フィルタ |
| #10 | エラー解決キャッシュ | 同じエラーの即解決 | error_resolution 自動蓄積・注入 |
| #11 | アーキテクチャドリフト検出 | — | Phase 4+ で検討 |
| #12 | サイレント障害検出 | — | テスト成功後アサーション品質チェック |
