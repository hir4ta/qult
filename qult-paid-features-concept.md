# qult Paid Features Concept

qult の課金レイヤー設計。ベース機能は OSS のまま、$2/user/月 で拡張機能をアンロックする freemium モデル。

## 前提

- qult 本体は OSS (MIT) のまま維持
- 課金機能はローカル完結を優先。クラウド依存は Phase 2 以降
- zero-dependency 原則は本体に適用。課金レイヤーは別パッケージ可

## 現状の制約 (コードから確認済み)

| 制約 | 該当コード | 影響 |
|------|-----------|------|
| 閾値ハードコード | `session-state.ts:isPaceRed()` — pace 120分/15ファイル | プロジェクト特性に合わない |
| Gate カテゴリ固定 | `load.ts` — on_write/on_commit/on_review の3つのみ | カスタム品質チェック不可 |
| ファイルフィルタなし | `runner.ts:runGate()` — 全ファイルに一律適用 | ディレクトリ別ルール不可 |
| メトリクス揮発 | `metrics.ts` — MAX_ENTRIES=500 で上書き | 長期トレンド追跡不可 |
| Gate履歴揮発 | `gate-history.ts` — 200件cap | エラーパターン分析に限界 |
| セッション状態リセット | `session-start.ts` — pending-fixes クリア | 前セッション情報消失 |
| Reviewer 静的 | `agent-reviewer.md` — few-shot 3例固定 | プロジェクト適応なし |
| 個人利用前提 | 全 state が ~/.claude/ or .qult/ ローカル | チーム可視性ゼロ |

## Phase 1: ローカル拡張 (クラウド不要)

### 1.1 閾値カスタマイズ

**痛み**: pace RED (120分/15ファイル), review 必須 (gated 5ファイル), Plan 大小境界 (4タスク) が全てハードコード。大規模モノレポと小規模ライブラリで最適値は異なる。

**設計**:

```json
// .qult/config.json
{
  "pace": {
    "time_minutes": 90,
    "max_files": 10
  },
  "review": {
    "min_gated_files": 3
  },
  "plan": {
    "large_threshold": 3
  }
}
```

**実装方針**:
- `loadConfig()` を追加。.qult/config.json があれば読み、なければデフォルト値
- `isPaceRed()`, `isReviewRequired()`, `permission-request.ts` の定数を config 参照に変更
- 無料版: config.json なし (デフォルト固定) / 有料版: config.json 有効

**実装コスト**: 小 (既存コードの定数抽出のみ)

### 1.2 カスタム Gate ルール

**痛み**: `runner.ts` は任意コマンド実行可能だが、gates.json のスキーマが on_write/on_commit/on_review の3カテゴリ固定。ファイルパターンマッチもない。

**設計**:

```json
// .qult/gates.json (拡張スキーマ)
{
  "on_write": {
    "lint": {
      "command": "biome check {file}",
      "timeout": 3000
    },
    "db_check": {
      "command": "bun run db:validate",
      "glob": "src/db/**",
      "timeout": 5000
    }
  },
  "on_commit": {
    "test": { "command": "bun vitest run", "timeout": 30000 },
    "bundle_size": {
      "command": "bun run check-bundle-size",
      "timeout": 10000
    }
  },
  "custom": {
    "security_scan": {
      "command": "bun run audit",
      "trigger": "on_write",
      "glob": "src/auth/**",
      "timeout": 15000
    }
  }
}
```

**実装方針**:
- `runner.ts:runGate()` に glob マッチング追加 (micromatch or minimatch)
- `load.ts` のスキーマ検証を拡張
- `custom` カテゴリ: trigger フィールドで既存カテゴリにマッピング
- 無料版: on_write/on_commit/on_review + glob なし / 有料版: custom + glob

**実装コスト**: 中 (glob 依存追加、runner 変更)

### 1.3 Gate プロファイル (プリセット)

**痛み**: `/qult:detect-gates` は自動検出するが、検出結果が最適とは限らない。フレームワーク固有のベストプラクティス (Next.js の build チェック、Prisma の schema validate 等) は検出されない。

**設計**:

```bash
qult init --profile nextjs    # Next.js 最適化プリセット
qult init --profile django    # Django プリセット
qult init --profile go        # Go プリセット
```

```json
// プリセット例: nextjs
{
  "on_write": {
    "lint": { "command": "next lint --file {file}", "timeout": 5000 },
    "typecheck": { "command": "tsc --noEmit", "timeout": 15000, "run_once_per_batch": true }
  },
  "on_commit": {
    "test": { "command": "jest --passWithNoTests", "timeout": 30000 },
    "build": { "command": "next build", "timeout": 60000 }
  }
}
```

**実装方針**:
- `src/profiles/` にプリセット定義 (TypeScript オブジェクト)
- `init.ts` に `--profile` フラグ追加
- 無料版: 自動検出のみ / 有料版: プリセット + カスタムプロファイル保存

**実装コスト**: 小 (プリセットデータ + init フラグ)

## Phase 2: 可視化 (クラウド or ローカル)

### 2.1 メトリクス永続化 + エクスポート

**痛み**: metrics.json の500件cap、gate-history.json の200件cap でデータが失われる。長期トレンドが追えない。

**設計 (ローカル優先)**:

```bash
qult metrics export --format json > metrics-2026-03.json
qult metrics export --format csv  > metrics-2026-03.csv
qult metrics export --since 2026-03-01
```

**設計 (クラウド)**:

```bash
qult metrics sync                # クラウドに送信
qult metrics dashboard           # ブラウザで開く
```

**実装方針**:
- Phase 2a (ローカル): export コマンド追加。cap 前にアーカイブファイルへ退避
- Phase 2b (クラウド): 匿名化した metrics を API に POST。Web UI で表示
- qult-tui-concept.md の TUI ダッシュボードとの統合も選択肢

**実装コスト**: 中 (export) / 大 (クラウド)

### 2.2 セッション監査ログ

**痛み**: session-state.json はセッション単位でリセット。pending-fixes は SessionStart でクリア。「前回のセッションで何が起きたか」が追跡不可能。

**設計**:

```
.qult/.state/sessions/
  2026-03-28T10-30-00.json    # セッション終了時にスナップショット
  2026-03-28T14-15-00.json
```

```typescript
// セッションスナップショット
{
  started_at: string,
  ended_at: string,
  duration_minutes: number,
  commits: number,
  denies: number,
  blocks: number,
  gates_run: number,
  gates_passed: number,
  first_pass_clean_rate: number,
  review_outcome: "pass" | "fail" | "skipped" | null,
  files_changed: string[]
}
```

**実装方針**:
- SessionStart で前セッションの state をスナップショットとして保存
- `qult sessions` コマンドで一覧表示
- 30日分を保持、古いものは自動削除

**実装コスト**: 小 (SessionStart に保存ロジック追加)

## Phase 3: チーム機能

### 3.1 チーム集計

**痛み**: 全 state がローカル。チームメンバー間で品質状況の共有手段がない。

**設計**:

```bash
qult team init                    # チームID生成
qult team join <team-id>          # チーム参加
qult team dashboard               # チーム集計 (Web)
```

**集計メトリクス**:
- チーム全体の gate pass rate / first-pass clean rate
- プロジェクト別・メンバー別の DENY 頻度
- 最も失敗する gate / 最頻エラーパターン

**実装方針**:
- 匿名化した metrics を API に送信 (ユーザー名はハッシュ化)
- Web ダッシュボードで集計表示
- プライバシー: コード内容・ファイルパスは送信しない。カウントとカテゴリのみ

**実装コスト**: 大 (API サーバー + Web UI + 認証)

### 3.2 Reviewer 学習フィードバック

**痛み**: `agent-reviewer.md` の few-shot 例は3つで静的。`review:miss` メトリクスは記録されるが改善に使われない。Anthropic リサーチに「Evaluator calibration に数ラウンド必要」とある。

**設計**:

```bash
qult review feedback <session-id>    # 前回レビューの findings を表示
# 各 finding に 👍 (有用) / 👎 (ノイズ) をマーク
```

```json
// .qult/reviewer-calibration.json
{
  "good_examples": [
    { "finding": "...", "context": "...", "why_useful": "..." }
  ],
  "noise_patterns": [
    { "finding": "...", "why_noise": "..." }
  ]
}
```

**実装方針**:
- reviewer-calibration.json からプロジェクト固有の few-shot 例を生成
- `agent-reviewer.md` のテンプレートに動的注入
- `review:miss` パターンを自動で good_examples に追加候補として提示

**実装コスト**: 中 (フィードバック UI + テンプレート動的生成)

## 課金モデル

```
┌─────────────────────────────────────────────────────┐
│  Free (OSS)                                         │
│  ・12 hooks (全機能)                                 │
│  ・gate 自動検出                                     │
│  ・reviewer (Opus 4.6)                              │
│  ・doctor --metrics (CLI)                            │
│  ・デフォルト閾値                                     │
├─────────────────────────────────────────────────────┤
│  Pro ($2/user/月)                                    │
│  ・閾値カスタマイズ (.qult/config.json)              │
│  ・カスタム Gate ルール (glob, custom カテゴリ)       │
│  ・Gate プロファイル (フレームワーク別プリセット)      │
│  ・セッション監査ログ (30日保持)                      │
│  ・メトリクス export (JSON/CSV)                      │
│  ・Reviewer フィードバック学習                        │
├─────────────────────────────────────────────────────┤
│  Team ($2/user/月 + $10/チーム/月)                   │
│  ・Pro 全機能                                        │
│  ・チーム集計ダッシュボード (Web)                     │
│  ・メトリクス クラウド同期                            │
│  ・チームレベルの Gate プリセット共有                  │
└─────────────────────────────────────────────────────┘
```

## ライセンス検証の設計方針

- ローカル機能 (Phase 1): ライセンスキーを .qult/license.json に配置。オフライン検証可能
- クラウド機能 (Phase 2-3): API キー認証
- OSS コアのフォーク防止は不要 — 課金価値は「設定の便利さ」であり「機能の存在」ではない
- fail-open 原則を維持: ライセンス検証失敗時はデフォルト値にフォールバック (品質保護を止めない)

## 優先順位

| 優先度 | 機能 | 理由 |
|--------|------|------|
| **P0** | 閾値カスタマイズ | 実装コスト最小、クラウド不要、即座に価値を提供 |
| **P0** | カスタム Gate ルール | 既存 runner.ts の自然な拡張、パワーユーザーの定着要因 |
| **P1** | セッション監査ログ | 実装コスト小、ローカル完結、デバッグ価値が高い |
| **P1** | Gate プロファイル | init.ts への追加のみ、エコシステム拡大の入口 |
| **P2** | メトリクス export | TUI ダッシュボード (qult-tui-concept.md) と統合可能 |
| **P2** | Reviewer フィードバック | 技術的に面白いが需要未検証 |
| **P3** | チーム集計 | インフラコスト大。個人利用の定着が先 |

## リスクと未検証事項

- **価格感度**: Claude Code プラグインの課金前例がほぼない。$2 が適正かは未検証
- **TAM**: Claude Code ユーザー × qult 認知率 × 課金転換率。全て未知数
- **インフラ ROI**: 100ユーザー × $2 = $200/月。クラウド機能のサーバー代で赤字の可能性
- **OSS vs 課金の境界**: 「壁」機能 (DENY/block) を課金に回すと安全性が下がる。課金は「便利さ」に限定すべき
- **フォーク耐性**: ローカル完結の課金機能はフォークで回避可能。ただし $2 なら払う方が楽という価格設定
