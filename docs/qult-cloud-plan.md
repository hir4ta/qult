# qult Cloud — プロダクト計画書

> **Status (2026-04-25)**: 本ドキュメントは v0.x 時代に書かれたクラウド連携の構想であり、**未着手**。v1.0 のローカル設計（SQLite 廃止、`.qult/state/*.json` ベース、hook 廃止）は反映されていない。本書中の「ローカル層 = SQLite」「hook が状態を書く」等の記述は v0.x のアーキテクチャ前提であり、クラウド作業に着手する際は v1.0 ベースで全面改訂が必要。
>
> v1.0 実装の状態管理は file-based JSON のため、cloud 同期は「`.qult/state/*.json` のうち共有可能な部分（review_completed_at / spec metadata 等）を集中ストレージにレプリケートする」設計に再構成すべき。

## 1. エグゼクティブサマリー

qult の既存ローカル品質ハーネスを無料層として維持しつつ、クラウド同期・可視化・チーム横断学習を有料層として提供する SaaS モデル。

**一言で**: AI 開発の品質を「構造で守り、データで証明する」プラットフォーム。

---

## 2. 解決する問題

### 2.1 市場の現状

| 事実 | 統計 | ソース |
|------|------|--------|
| AI コードの 45% にセキュリティ脆弱性 | 複数テストサイクルでも改善せず | Veracode 2025 |
| PR 量 +98% だが DORA メトリクス変化なし | レビュー時間 +91%、AI PR 受入率 32.7% | Gradle (10,000+ 開発者) |
| AI 開発者の commit 3-4x だがセキュリティ所見 10x | セキュリティ負債 > 改善速度 | CSA Fortune 50 データ |
| プロンプトルールの違反率 83% | エージェントは要件を「好み」として扱う | AgentPex (Microsoft Research) |
| 組織的生産性向上はわずか ~10% | 92.6% 採用率なのに | 6 独立研究の収束 |

### 2.2 既存ツールが解決できていない課題

1. **品質の不可視性** — AI がどれだけの問題を生んでいるか、マネージャーが把握できない
2. **チーム横断の学習不在** — A チームが踏んだ罠を B チームが繰り返す
3. **品質強制のローカル閉じ込め** — 個人の設定で完結し、チーム標準が浸透しない
4. **「速くなった気がする」の罠** — 体感と実測の乖離を数値で示すツールがない

### 2.3 qult が既に解決している課題

- hooks による構造的品質強制（exit 2 DENY）
- 17 detectors による多層防御（セキュリティ、dataflow、複雑度、テスト品質）
- 4 ステージ独立レビュー
- fail-open 設計（qult の障害で開発を止めない）
- セッション横断の flywheel 学習（ローカル）

**qult Cloud は「解決」を「証明」に変える。個人の品質保証をチームの品質文化に拡張する。**

---

## 3. ゴール

### 3.1 プロダクトゴール

| ゴール | 成功指標 | 期限目安 |
|--------|---------|---------|
| 無料ユーザーの体験を壊さない | 既存 hook レイテンシ維持 (<500ms) | 常時 |
| ダッシュボードで品質を可視化 | 「AI 開発、うちは大丈夫？」に答えられる | v1.0 |
| チーム横断学習を実現 | A チームの学びが B チームに自動伝搬 | v1.1 |
| MRR $10K 到達 | ~500 seat (Team) or ~1000 seat (Pro) | 12ヶ月以内 |

### 3.2 技術ゴール

| ゴール | 理由 |
|--------|------|
| ローカル SQLite のレイテンシを維持 | hook は全ツール実行で発火する。遅延は DX を殺す |
| fail-open をクラウドにも適用 | クラウド接続断でもローカルは完全動作 |
| pgvector を初期から導入 | セマンティック検索・パターンマッチングの基盤 |
| セルフホスト対応を視野に入れる | Enterprise 需要への拡張性確保 |

---

## 4. アーキテクチャ

### 4.1 全体構成

```
┌─────────────────────────────────────────────────────────┐
│                    ユーザー環境 (ローカル)                    │
│                                                         │
│  Claude Code / Cursor / Windsurf / Cline                │
│       │                                                 │
│       ▼                                                 │
│  ┌─────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │  hooks   │───▶│ SQLite (WAL) │    │ settings.json │  │
│  │ (7本)    │◀───│ ~/.qult/     │    │ ~/.qult/      │  │
│  └─────────┘    │ qult.db      │    │               │  │
│       │         └──────────────┘    └───────────────┘  │
│       │                │                                │
│  ┌─────────┐           │ 非同期バッチ同期                  │
│  │  MCP    │           │ (有料ユーザーのみ)                 │
│  │ Server  │           ▼                                │
│  └─────────┘    ┌──────────────┐                        │
│                 │  Sync Agent  │                        │
│                 │ (バックグラウンド) │                        │
│                 └──────┬───────┘                        │
└────────────────────────┼────────────────────────────────┘
                         │ HTTPS (TLS 1.3)
                         │ API Key 認証
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    qult Cloud                           │
│                                                         │
│  ┌──────────┐    ┌──────────────────────────────────┐  │
│  │  API     │───▶│  PostgreSQL + pgvector            │  │
│  │  Server  │◀───│                                    │  │
│  └──────────┘    │  ├── metrics (セッションメトリクス)    │  │
│       │          │  ├── detections (detector 検出履歴)  │  │
│       │          │  ├── gate_configs (チーム共有設定)    │  │
│       │          │  ├── knowledge (ベクトル埋め込み)     │  │
│       │          │  └── teams (組織・メンバー管理)       │  │
│       ▼          └──────────────────────────────────┘  │
│  ┌──────────┐                                          │
│  │  Web     │    ダッシュボード                           │
│  │  App     │    ├── 品質メトリクス推移                    │
│  │          │    ├── detector 検出傾向                    │
│  │          │    ├── チーム比較                           │
│  │          │    └── flywheel 推奨                       │
│  └──────────┘                                          │
└─────────────────────────────────────────────────────────┘
```

### 4.2 二層アーキテクチャの原則

| 層 | データストア | 用途 | レイテンシ要件 |
|----|------------|------|-------------|
| **ローカル層** | SQLite (WAL) | hook 実行、gate 判定、pending-fixes | <1ms |
| **クラウド層** | PostgreSQL + pgvector | 可視化、チーム学習、セマンティック検索 | <500ms (非同期OK) |

**鉄則**:
- hook の実行パスにネットワーク I/O を入れない
- クラウド接続断 → ローカルは完全動作（fail-open）
- 同期は非同期バッチ（セッション終了時 or アイドル時）

### 4.3 データフロー

```
[リアルタイム: ローカル完結]

  Edit → PostToolUse hook
           │
           ├── detectors 実行 (security, dataflow, complexity, ...)
           ├── gate 実行 (lint, typecheck)
           ├── PendingFix 書き込み → SQLite
           └── メトリクス記録 → SQLite
                                    │
                                    ▼
[非同期: クラウド同期 (有料のみ)]

  SessionEnd / Idle / 手動トリガー
           │
           ├── 未同期メトリクスを PostgreSQL に push
           ├── detector 検出履歴を push
           ├── gate 設定の差分を pull (チーム設定)
           └── flywheel 推奨を pull (チーム横断分析)
```

### 4.4 同期プロトコル

```
Sync Agent (ローカル)
  │
  │  POST /api/v1/sync
  │  Headers: Authorization: Bearer qult_sk_...
  │  Body: {
  │    project_id: "hash(cwd)",
  │    since: "2026-04-12T10:00:00Z",  // 前回同期時刻
  │    metrics: [...],                   // 新規メトリクス
  │    detections: [...],                // detector 検出
  │    gate_events: [...]                // gate pass/fail イベント
  │  }
  │
  ▼
API Server (クラウド)
  │
  │  Response: {
  │    team_config_updates: [...],       // チーム設定の変更
  │    flywheel_recommendations: [...],  // チーム横断の推奨
  │    sync_cursor: "2026-04-12T12:00:00Z"
  │  }
  │
  ▼
Sync Agent
  │
  └── team_config_updates を SQLite に反映
```

---

## 5. 料金プラン

### 5.1 プラン構成

| | Free | Pro | Team |
|--|------|-----|------|
| **価格** | $0 | $10/seat/月 | $25/seat/月 |
| **対象** | 個人開発者 | 小チーム (2-10人) | 組織 (10人+) |
| hooks + detectors (ローカル) | ✅ | ✅ | ✅ |
| 4 ステージ独立レビュー | ✅ | ✅ | ✅ |
| ローカル flywheel | ✅ | ✅ | ✅ |
| skills + agents | ✅ | ✅ | ✅ |
| **ダッシュボード (個人)** | ❌ | ✅ | ✅ |
| **メトリクス履歴 (90日)** | ❌ | ✅ | ✅ |
| **セマンティック検索** | ❌ | ✅ | ✅ |
| **チーム横断ダッシュボード** | ❌ | ❌ | ✅ |
| **チーム横断 flywheel** | ❌ | ❌ | ✅ |
| **gate 設定のチーム同期** | ❌ | ❌ | ✅ |
| **管理者コンソール** | ❌ | ❌ | ✅ |
| **メトリクス履歴 (無制限)** | ❌ | ❌ | ✅ |
| **セルフホスト** | ❌ | ❌ | 別途相談 |

### 5.2 価格の根拠

| 項目 | 根拠 |
|------|------|
| Free = 既存機能全て | 無料ユーザーからの信頼がファネルの入り口 |
| Pro $10/seat | Cursor $20, Copilot $19 の半額。「補助ツール」の価格帯 |
| Team $25/seat | マネージャーが稟議なしで承認できる上限ライン |

### 5.3 コスト構造 (Pro ユーザー1人あたり)

| コスト項目 | 月額見込み |
|-----------|-----------|
| PostgreSQL (Neon/Supabase 共有) | ~$0.50 |
| pgvector embedding 生成 | ~$0.30 |
| API サーバー (per-seat 按分) | ~$0.50 |
| Web ホスティング | ~$0.20 |
| **合計** | **~$1.50** |
| **粗利** | **~$8.50 (85%)** |

---

## 6. 機能詳細

### 6.1 ダッシュボード (Pro / Team)

品質メトリクスの可視化。**「AI 開発、うちは大丈夫？」に答えるスクリーンショット。**

#### メトリクスパネル

```
┌─────────────────────────────────────────────────────┐
│  qult Dashboard — project: my-app                   │
├─────────────────────────────────────────────────────┤
│                                                     │
│  品質スコア推移 (30日)          Gate Pass Rate        │
│  ┌──────────────────┐        ┌──────────────┐      │
│  │  ▁▂▃▄▅▆▇█▇▆▇█   │        │ lint:    98%  │      │
│  │  Score: 34/40    │        │ type:    95%  │      │
│  └──────────────────┘        │ test:    87%  │      │
│                               │ review:  92%  │      │
│  Detector 検出傾向             └──────────────┘      │
│  ┌──────────────────┐                               │
│  │ security:  ▇▅▃▂▁ │  ← 改善傾向                   │
│  │ dead-import: ▁▂▃▅ │  ← 悪化傾向 (要注意)          │
│  │ duplication: ▃▃▃▃ │  ← 横ばい                    │
│  └──────────────────┘                               │
│                                                     │
│  セッション統計                                       │
│  ├── 今月のセッション数: 47                            │
│  ├── 平均 gate failure/session: 3.2                  │
│  ├── 平均レビュースコア: 34.2/40                       │
│  └── ブロックされたコミット: 12 (うち security: 8)      │
│                                                     │
│  Flywheel 推奨                                       │
│  ├── security_threshold: 10→7 (高信頼度)              │
│  └── complexity_threshold: 15→12 (中信頼度)           │
└─────────────────────────────────────────────────────┘
```

#### チーム比較パネル (Team のみ)

```
┌─────────────────────────────────────────────────────┐
│  チーム横断ビュー                                      │
├─────────────────────────────────────────────────────┤
│                                                     │
│  チーム別品質スコア                                     │
│  ┌─────────────────────────────────────────┐        │
│  │ backend-team:   ████████░░ 34/40        │        │
│  │ frontend-team:  ██████░░░░ 28/40        │        │
│  │ infra-team:     █████████░ 36/40        │        │
│  └─────────────────────────────────────────┘        │
│                                                     │
│  共通の弱点                                           │
│  ├── XSS 防御: 3チーム中 2チームで頻出                  │
│  ├── テスト品質: empty-test が全チームで検出             │
│  └── 推奨: security-check の XSS パターンを強化        │
│                                                     │
│  クロスチーム学習の適用履歴                               │
│  ├── 2026-04-10: infra の complexity 閾値 → 全チーム   │
│  └── 2026-04-05: backend の security パターン → 全体   │
└─────────────────────────────────────────────────────┘
```

### 6.2 セマンティック検索 (Pro / Team)

pgvector による過去のメトリクス・検出のベクトル検索。

**ユースケース**:
- 「前に SQL インジェクションを直したとき、どう対処した？」
- 「このファイルと似た問題を起こしたプロジェクトはある？」
- 「complexity が高いファイルのリファクタリングパターンは？」

**MCP tool として提供**:
```
search_knowledge(query: string, limit?: number)
  → 過去の検出・修正パターンをセマンティック検索
  → ベクトル類似度でランキング
```

**Embedding 生成**:
- detector 検出 + 修正パッチのペアを embedding 化
- gate 失敗 → 修正 → pass の「解決パターン」を蓄積
- セッション終了時にバッチ生成（リアルタイム不要）

### 6.3 チーム横断 flywheel (Team)

現在のローカル flywheel を拡張し、チーム間でパターンを共有。

**メカニズム**:
```
チーム A のセッション履歴
  ├── security_warnings: 平均 2.1/session (閾値 10→7 推奨)
  ├── complexity: 閾値 15 で安定
  └── test_quality: empty-test 検出率 低下傾向

チーム B のセッション履歴
  ├── security_warnings: 平均 4.3/session (閾値 10 のまま)
  ├── complexity: 閾値 15 で頻繁に引っかかる
  └── test_quality: empty-test 検出率 横ばい

        ▼ クロスチーム分析

推奨:
  1. チーム A の security_threshold 7 をチーム B にも提案
  2. チーム B に complexity_threshold 12 を提案 (チーム A で安定実績あり)
  3. empty-test の blocking 昇格を全チームに適用
```

**自動適用ルール**:
- raise 方向（閾値を厳しく）: チーム管理者の承認後に適用
- lower 方向（閾値を緩く）: 自動適用しない（必ず管理者判断）

### 6.4 gate 設定のチーム同期 (Team)

管理者が設定した gate 設定をチーム全体に配布。

```
管理者がダッシュボードで設定:
  on_write: { lint: "biome check {file}", typecheck: "tsc --noEmit" }
  on_commit: { test: "vitest run" }
  escalation: { security_threshold: 7 }

        ▼ 同期

チームメンバーの ~/.qult/qult.db に自動反映
  (次回 sync 時に pull)
```

**競合解決**:
- チーム設定 > 個人設定（上書き）
- 個人が `/qult:skip` で一時無効化は可能（監査ログに記録）

---

## 7. 技術スタック

### 7.1 ローカル (既存 + 拡張)

| コンポーネント | 技術 | 変更点 |
|--------------|------|--------|
| hooks / detectors | Bun + TypeScript | 変更なし |
| ローカル DB | SQLite (WAL) | 変更なし |
| MCP Server | raw JSON-RPC | sync 関連 tool 追加 |
| Sync Agent | Bun (バックグラウンド) | **新規** |
| settings.json | JSON | **新規** (~/.qult/settings.json) |

### 7.2 クラウド (新規)

| コンポーネント | 技術 | 理由 |
|--------------|------|------|
| API Server | Hono (Bun) or Fastify | 軽量、TypeScript |
| Database | PostgreSQL 16 + pgvector | ベクトル検索、エコシステム |
| Web App | Next.js or SvelteKit | ダッシュボード |
| 認証 | API Key (CLI) + OAuth (Web) | シンプル |
| ホスティング | Fly.io or Railway | Bun 対応、低コスト |
| Embedding | OpenAI text-embedding-3-small | コスト最適 |

### 7.3 PostgreSQL スキーマ (初期設計)

```sql
-- 組織・チーム
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'pro',  -- 'pro' | 'team'
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id),
  api_key TEXT UNIQUE NOT NULL,       -- qult_sk_...
  display_name TEXT,
  role TEXT DEFAULT 'member',         -- 'admin' | 'member'
  created_at TIMESTAMPTZ DEFAULT now()
);

-- プロジェクト
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id),
  project_hash TEXT NOT NULL,          -- hash(cwd)
  project_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, project_hash)
);

-- メトリクス (セッション単位)
CREATE TABLE session_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  member_id UUID REFERENCES members(id),
  recorded_at TIMESTAMPTZ NOT NULL,
  gate_failure_count INTEGER DEFAULT 0,
  security_warnings INTEGER DEFAULT 0,
  dead_import_warnings INTEGER DEFAULT 0,
  duplication_warnings INTEGER DEFAULT 0,
  test_quality_warnings INTEGER DEFAULT 0,
  review_aggregate REAL,
  review_stages JSONB,
  changed_file_count INTEGER DEFAULT 0,
  session_duration_minutes INTEGER
);

-- Detector 検出履歴
CREATE TABLE detections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  member_id UUID REFERENCES members(id),
  detected_at TIMESTAMPTZ NOT NULL,
  detector TEXT NOT NULL,              -- 'security-check', 'dataflow-check', ...
  file_path TEXT NOT NULL,
  severity TEXT NOT NULL,              -- 'blocking' | 'advisory'
  message TEXT NOT NULL,
  resolved_at TIMESTAMPTZ,            -- NULL = 未解決
  resolution TEXT                      -- 修正内容 (embedding 元)
);

-- Gate イベント
CREATE TABLE gate_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  member_id UUID REFERENCES members(id),
  occurred_at TIMESTAMPTZ NOT NULL,
  gate_name TEXT NOT NULL,             -- 'lint', 'typecheck', 'test', 'review'
  result TEXT NOT NULL,                -- 'pass' | 'fail' | 'skip'
  file_path TEXT,
  duration_ms INTEGER,
  error_summary TEXT
);

-- チーム gate 設定
CREATE TABLE team_gate_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id),
  config_key TEXT NOT NULL,
  config_value JSONB NOT NULL,
  updated_by UUID REFERENCES members(id),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, config_key)
);

-- ナレッジベース (pgvector)
CREATE TABLE knowledge_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  entry_type TEXT NOT NULL,            -- 'detection_resolution', 'gate_pattern', 'decision'
  content TEXT NOT NULL,               -- 人間可読テキスト
  embedding vector(1536) NOT NULL,     -- text-embedding-3-small
  metadata JSONB,                      -- detector, file_path, etc.
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX knowledge_embedding_idx
  ON knowledge_entries
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 監査ログ
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id),
  member_id UUID REFERENCES members(id),
  action TEXT NOT NULL,
  detail JSONB,
  occurred_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 8. settings.json 設計

```jsonc
// ~/.qult/settings.json
{
  // Free ユーザー: このファイルなし or cloud フィールドなし
  // → 従来通り SQLite のみで動作

  // Pro / Team ユーザー:
  "cloud": {
    "api_key": "qult_sk_xxxxxxxxxxxxxxxxxxxx",
    "sync_enabled": true,
    "sync_interval": "session_end",  // "session_end" | "idle" | "manual"
    "endpoint": "https://api.qult.dev"  // デフォルト。セルフホスト時に変更
  }
}
```

**設定フロー**:
```
$ /qult:init

  既存の gate 自動検出 (変更なし)
  ...

  qult Cloud に接続しますか？ (API Key をお持ちの場合)
  > API Key: qult_sk_xxxxxxxxxxxxxxxxxxxx

  ✅ 接続確認完了 (org: my-team, plan: pro)
  ✅ ~/.qult/settings.json に保存しました
  ✅ 次回セッション終了時からクラウド同期が開始されます
```

---

## 9. ローカル変更の影響範囲

既存の qult コードベースへの変更を最小限にする。

### 9.1 変更が必要なファイル

| ファイル | 変更内容 | 影響度 |
|---------|---------|--------|
| src/state/db.ts | settings.json 読み込み追加 | 小 |
| src/hooks/session-start.ts | Sync Agent 初期化 (有料のみ) | 小 |
| src/hooks/stop.ts | セッション終了時の同期トリガー | 小 |
| src/mcp-server.ts | search_knowledge tool 追加 | 小 |
| **新規**: src/cloud/sync.ts | 同期ロジック | 新規 |
| **新規**: src/cloud/settings.ts | settings.json パーサー | 新規 |

### 9.2 変更しないもの

| コンポーネント | 理由 |
|--------------|------|
| 全 detector | ローカル完結のまま |
| gate runner | ローカル完結のまま |
| pre-tool / post-tool hook のコアロジック | ローカル SQLite のまま |
| skills / agents | 変更不要 |
| pending-fixes の読み書き | ローカル完結のまま |

---

## 10. 実装ロードマップ

### Phase 1: 基盤 (v0.29)

**目標**: settings.json + 同期インフラ + クラウド API 基盤

- [ ] ~/.qult/settings.json の読み込み・バリデーション
- [ ] PostgreSQL スキーマ + マイグレーション
- [ ] Sync Agent (セッション終了時のバッチ同期)
- [ ] API Server (認証 + sync エンドポイント)
- [ ] API Key 発行・管理

### Phase 2: ダッシュボード (v1.0) — 最優先

**目標**: 「AI 開発の品質、見える化」の MVP

- [ ] Web ダッシュボード (個人ビュー)
  - [ ] 品質スコア推移グラフ
  - [ ] Gate pass/fail rate
  - [ ] Detector 検出傾向
  - [ ] セッション統計
- [ ] Flywheel 推奨の表示
- [ ] ランディングページ + 料金ページ
- [ ] Stripe 決済連携

### Phase 3: セマンティック検索 (v1.1)

**目標**: 過去のナレッジを活用

- [ ] Embedding 生成パイプライン
- [ ] pgvector インデックス最適化
- [ ] MCP tool: search_knowledge
- [ ] ダッシュボードでのナレッジ検索 UI

### Phase 4: チーム機能 (v1.2)

**目標**: チーム横断の品質文化

- [ ] チーム管理 (招待、ロール)
- [ ] チーム横断ダッシュボード
- [ ] Gate 設定のチーム同期
- [ ] チーム横断 flywheel
- [ ] 管理者コンソール
- [ ] 監査ログ

### Phase 5: Enterprise (v2.0)

**目標**: セルフホスト + 高度な機能

- [ ] Docker Compose によるセルフホストパッケージ
- [ ] SSO (SAML / OIDC)
- [ ] カスタム detector のクラウド実行
- [ ] API (CI/CD 統合、品質ゲートとして)
- [ ] SLA / サポート

---

## 11. リスクと緩和策

| リスク | 影響 | 緩和策 |
|--------|------|--------|
| Claude Code auto memory の進化 | 無料機能がキャッチアップ | セマンティック検索 + チーム機能で差別化。auto memory は「記憶」、qult は「品質の証明」 |
| 抽出精度が低い場合 | ゴミ DB 問題 | Phase 1 で precision/recall ベンチマーク。detector 検出 + gate イベントは構造化データなので精度問題なし |
| クラウド接続の不安定さ | 開発体験の劣化 | 二層アーキテクチャ + fail-open。ローカルは独立動作 |
| 価格競争 | 粗利の圧迫 | Pro $10 で 85% 粗利を確保。機能差で競争、価格で競争しない |
| セキュリティ懸念 (コード情報の送信) | 企業ユーザーの抵抗 | 送信するのはメトリクス + 検出サマリーのみ。ソースコードは送信しない。セルフホストオプション |
| MCP 標準の変化 | プロトコル互換性 | MCP は Anthropic 主導で安定化傾向。リスク低 |

---

## 12. 競合との差別化

| 競合 | 彼らの強み | qult Cloud の差別化 |
|------|-----------|-------------------|
| Claude Code auto memory | 無料、組み込み | チーム共有、セマンティック検索、可視化 |
| claude-mem | OSS、シンプル | 品質メトリクスに特化 (ナレッジ汎用ではない) |
| Cursor Rules | エディタ統合 | ツール横断、構造的強制 (exit 2) |
| Pieces.app | コードスニペット | 品質ハーネスとの統合 |
| CodeScene | コードヘルス | AI 開発に特化、リアルタイム (コミット前) |
| SonarQube Cloud | 静的解析 | AI エージェント特化、hook ベースの即時強制 |

**qult Cloud のユニークポジション**:
> 唯一の「AI エージェント専用品質ハーネス + クラウド可視化」プラットフォーム。
> 他ツールは「コードの品質」を見る。qult は「AI がコードを書くプロセスの品質」を見る。

---

## 13. 成功の定義

| マイルストーン | 指標 | 目標 |
|--------------|------|------|
| Phase 1 完了 | 同期が動く | 技術検証完了 |
| Phase 2 (v1.0) リリース | 有料ユーザー | 50 seat |
| 6ヶ月後 | MRR | $3,000 |
| 12ヶ月後 | MRR | $10,000 |
| 12ヶ月後 | Free ユーザー | 1,000+ |
| 12ヶ月後 | NPS | 40+ |
