# Design: sdd-rewrite

## Architecture

### 全体像

```
[ Claude (architect agent) ]
        ↓ slash command
[ qult skills (.md prompts) ]
        ↓ MCP tool call
[ qult MCP server (mcp-server.mjs) ]
        ↓ filesystem I/O
[ .qult/ (project-local files) ]
        ↑ also read directly by Claude / reviewers
[ specs/<name>/{requirements,design,tasks}.md, waves/wave-NN.md ]
[ state/{current,pending-fixes,stage-scores}.json ]
[ config.json ]
```

### コア原則

1. **Markdown は single source of truth**。MCP tool は markdown ファイルを読み書きする抽象層。Claude も MCP 経由で更新するが、読みは直接 Read ツールで OK。
2. **State は project-local**。SQLite なし、global config なし、`~/.qult/` ディレクトリ自体不要。
3. **Skill は prompt、MCP tool は副作用**。skill は orchestration、MCP は副作用を集約。
4. **Detector は既存実装をそのまま使う**。SQLite 依存箇所のみ JSON ファイル I/O に差し替え。
5. **Agent は prompt の差し替えのみ**。命名は plan → spec、内部ロジックは現行 plan-generator/evaluator から派生。

## ファイル I/O 抽象化

### 現状（撤廃対象）

```
src/state/
├── db.ts              ← bun:sqlite 依存、撤廃
├── audit-log.ts       ← 撤廃（filesystem ベースで再実装するなら state/log.ts）
├── flush.ts           ← 撤廃（DB transaction 用、不要）
├── pending-fixes.ts   ← JSON 化
├── plan-status.ts     ← spec-status.ts にリネーム + JSON 化
└── session-state.ts   ← project-state.ts にリネーム + JSON 化
```

### 新構造

```
src/state/
├── paths.ts           ← .qult/ 配下のパス算出（cwd ベース）
├── fs.ts              ← atomic write、mtime 比較、JSON read/write 共通化
├── config.ts          ← config.json の読み書き（既存 src/config.ts は統合）
├── current.ts         ← current.json (test_passed_at, review_completed_at, ...)
├── pending-fixes.ts   ← pending-fixes.json
├── stage-scores.ts    ← stage-scores.json
├── spec.ts            ← active spec の判定、archive 操作、wave-NN.md 生成
└── tasks-md.ts        ← tasks.md / wave-NN.md の parser & writer
```

### atomic write 戦略

複数 Claude セッション同時起動の write 競合対策:
- 全 JSON 書き込みは `<file>.tmp` → `rename` の 2 ステップ
- markdown 書き込みは last-write-wins（mtime チェックは行わない、coordination は Claude の責務）
- 競合検知のためのファイルロックは導入しない（complexity 増、現実的に問題にならない）

### markdown parser 設計

tasks.md の構造はシンプルなので**専用 parser を自作**。外部ライブラリ依存は避ける（bun build バンドルサイズ抑制）。

tasks.md 期待フォーマット:
```markdown
# Tasks: <spec-name>

## Wave 1: <title>
**Goal**: ...
**Verify**: ...

- [ ] T1.1: <task>
- [x] T1.2: <task>
- [~] T1.3: <task>   ← in_progress
- [!] T1.4: <task>   ← blocked

## Wave 2: <title>
...
```

parser:
- `## Wave (\d+):` で Wave セクション分割
- `- \[(.)\] (T\d+\.\d+): (.+)` で task 抽出、status は `' '` / `'x'` / `'~'` / `'!'`
- writer は parse → status 更新 → 元のフォーマットに保ちつつ書き戻し

エラー対応: parse fail 時は MCP tool が例外を返す（破壊的書き込み回避）。Claude にエラー内容を返し、ユーザーに修正を促す。

## MCP server の再構成

### 削除する tool 実装

- `archive_plan` → `archive_spec` に移管
- `get_session_status` → `get_project_status` にリネーム

### 追加する tool 実装

| tool | 入力 | 出力 | 副作用 |
|---|---|---|---|
| `get_active_spec` | なし | `{ name, phase, current_wave, total_waves, scores, open_questions_count } \| null` | なし |
| `complete_wave` | `{ wave_num, commit_range }` | `{ ok }` | wave-NN.md 更新 |
| `update_task_status` | `{ wave_num, task_id, status: 'pending' \| 'in_progress' \| 'done' \| 'blocked' }` | `{ ok }` | tasks.md / wave-NN.md 更新 |
| `archive_spec` | `{ spec_name }` | `{ archived_path }` | specs/<name>/ → specs/archive/<name>/ 移動 |
| `record_spec_evaluator_score` | `{ phase, total, dim_scores }` | `{ ok }` | state/stage-scores.json 更新 |

### tool 実装の共通化

現状 mcp-server.ts は 864 行。ファイル化により行数は減るが、tool 数は 16 → 20 に増える。tool ごとの handler を `src/mcp-tools/<tool-name>.ts` に分割する案を採用。

```
src/mcp-tools/
├── index.ts              ← tool 登録レジストリ
├── get-active-spec.ts
├── complete-wave.ts
├── update-task-status.ts
├── archive-spec.ts
├── record-spec-evaluator-score.ts
├── get-project-status.ts
├── ... (残り 14 tool)
└── shared.ts             ← 共通エラーハンドリング
```

mcp-server.ts は registry を import して JSON-RPC dispatch のみを担当する（〜200 行を目標）。

## Agent prompt の設計

### spec-generator (Sonnet)

phase 引数で生成対象切替:
- `phase: "requirements"` — `<description>` を読み、EARS notation の requirements.md draft を生成。Open Questions セクションを必ず含める。
- `phase: "design"` — requirements.md を読み、design.md を生成。Architecture / Data Model / Interfaces / Dependencies / Alternatives Considered / Risks セクション。
- `phase: "tasks"` — requirements.md と design.md を読み、tasks.md を生成。Wave 分割は以下のルールを厳守:
  - 各 Wave 単体で build / test 通過
  - 各 Wave の task 数 3-7
  - spec 全体の Wave 数 2-6
  - Wave 1 は scaffold（最初から動くものを目指す）
  - Wave 間は strict 順序（並列なし）

### spec-clarifier (Opus)

入力: requirements.md（特に Open Questions セクションと Acceptance Criteria）
出力: 5-10 件の質問。各質問は以下の構造:
```
Q<n>: <質問本文>
    a) <選択肢 A>
    b) <選択肢 B>
    c) その他（自由記述）
    推奨: <a|b|c> — <理由>
```

質問タイプ tag（内部使用）: `scope` / `numeric` / `edge_case` / `stakeholder` / `performance` / `security` / `integration`

ユーザー回答後、回答内容を解析して requirements.md の Acceptance Criteria 追記 + Open Questions の `[closed]` マーキング。

「お任せ」相当の回答検知パターン: "推奨で" / "任せる" / "わからない" / "決めて" → 推奨を採用し当該 AC に「(AI 推奨により採用)」注記。

スコープ大幅変更検知: clarify 後の AC 数が初期 draft の 1.5 倍を超えるか、新キーワードが requirements.md タイトルから推測される領域外の場合、ユーザーに改名提案。

### spec-evaluator (Opus)

phase 引数で評価対象切替:
- `phase: "requirements"` — Completeness / Testability / Unambiguity / Feasibility 各 5 点、threshold 18、floor 4
- `phase: "design"` — 同 4 次元、threshold 17、floor 4
- `phase: "tasks"` — 同 4 次元、threshold 16、floor 4

Testability の判定基準（requirements）:
- 各 EARS 文が「観測可能な条件」と「観測可能な結果」を持つ
- 「適切に」「ちゃんと」等の曖昧語ゼロ
- 数値が必要な箇所で数値が明示されている

Unambiguity の判定基準（requirements）:
- Open Questions が空（または `[closed]` のみ）
- AC 同士の矛盾なし

Feasibility は design / tasks フェーズで再評価。requirements では「明らかに技術的に不可能でないか」のみ。

出力フォーマット:
```json
{
  "total": 18,
  "dim_scores": {"completeness": 5, "testability": 4, "unambiguity": 5, "feasibility": 4},
  "verdict": "pass" | "fail",
  "feedback": "<改善提案、fail 時のみ>"
}
```

### 既存 reviewer の互換性

`spec-reviewer` / `quality-reviewer` / `security-reviewer` / `adversarial-reviewer` agent は現行のまま。ただし spec-reviewer の prompt に「plan」言及がある場合は「spec」へ置換。判定対象は spec 全体のコード変更（複数 Wave のコミット差分）。

## Skill 実装方針

### 新規 skill

| skill | 主処理 |
|---|---|
| `/qult:spec` | spec-generator → spec-clarifier → spec-evaluator (req) → spec-generator (design) → spec-evaluator (design) → spec-generator (tasks) → spec-evaluator (tasks) |
| `/qult:clarify` | 既存 spec の Open Questions を読み込み、spec-clarifier を起動 |
| `/qult:wave-start` | tasks.md から次 Wave を特定、`git rev-parse HEAD` を waves/wave-NN.md に start commit として記録 |
| `/qult:wave-complete` | テスト実行 → detector 実行 → コミットメッセージ生成 → ユーザー確認 → コミット → wave-NN.md に range 記録 → 次 Wave preview |
| `/qult:wip` | `git status` 確認 → message 生成 → `[wave-NN] wip: <msg>` でコミット |

### 既存 skill の改修

| skill | 改修内容 |
|---|---|
| `/qult:status` | spec 情報統合、`/qult:status archive` で archive 一覧 |
| `/qult:init` | `.qult/specs/`, `.qult/state/`, `.qult/config.json` 生成、`.gitignore` に `.qult/state/` 追加 |
| `/qult:finish` | spec 完了状態の判定、archive 移動コミット作成 |
| `/qult:doctor` | DB 健康診断を撤廃、ファイル整合性チェックに置換 |
| `/qult:config` | config.json 編集（SQLite global_configs / project_configs を撤廃） |
| `/qult:skip` | gate 操作はファイルベースに置換 |
| `/qult:update` | rules 配布先は `~/.claude/rules/`、新 5 ファイル（plan-mode → spec-mode 含む） |
| `/qult:uninstall` | プロジェクト `.qult/` の削除案内、ホーム配下は対象外（そもそも作らない） |
| `/qult:review` | 変更最小、reviewer prompt の plan 言及を spec に置換 |
| `/qult:debug` | 変更なし |

### 廃止 skill

`/qult:plan-generator` → `/qult:spec` に置換。skill ディレクトリは削除。

## Workflow rules の更新

`plugin/rules/` 5 ファイルを書き換え:

| 旧ファイル | 新ファイル | 主な変更 |
|---|---|---|
| `qult-plan-mode.md` | `qult-spec-mode.md` | EnterPlanMode は調査時のみ、実装は `/qult:spec` |
| `qult-workflow.md` | 同名 | Plan → Spec、Wave 概念追加 |
| `qult-pre-commit.md` | 同名 | Wave commit 時の checklist、`[wave-NN]` prefix |
| `qult-review.md` | 同名 | spec 完了時のみ自動、Wave 中は手動 |
| `qult-quality.md` | 同名 | spec_eval / wave 設定の言及追加 |

`/qult:init` および `/qult:update` は plan-mode.md を削除し spec-mode.md を配置する処理を含む。

## State ファイル schema

### `.qult/state/current.json`

```json
{
  "schema_version": 1,
  "test_passed_at": "2026-04-25T15:30:00Z" | null,
  "test_command": "bun vitest run" | null,
  "review_completed_at": "2026-04-25T16:00:00Z" | null,
  "review_score": 32 | null,
  "finish_started_at": null,
  "human_approval_at": null,
  "last_active_wave": 2 | null
}
```

### `.qult/state/pending-fixes.json`

```json
{
  "schema_version": 1,
  "fixes": [
    {
      "id": "<uuid>",
      "detector": "security-check",
      "severity": "high" | "medium" | "low",
      "file": "src/auth.ts",
      "line": 42,
      "message": "...",
      "created_at": "..."
    }
  ]
}
```

### `.qult/state/stage-scores.json`

```json
{
  "schema_version": 1,
  "spec_eval": {
    "requirements": {"total": 18, "dim_scores": {...}, "iteration": 1, "evaluated_at": "..."},
    "design": {...},
    "tasks": {...}
  },
  "review": {
    "spec_compliance": {...},
    "code_quality": {...},
    "security": {...},
    "adversarial": {...}
  }
}
```

### `.qult/specs/<name>/waves/wave-NN.md`

```markdown
# Wave 2: <title>

**Goal**: ...
**Verify**: ...
**Started at**: 2026-04-25T15:00:00Z
**Completed at**: 2026-04-25T16:30:00Z

## Tasks
- [x] T2.1: ...
- [x] T2.2: ...

## Commits
- abc1234: feat: ...
- def5678: test: ...

**Range**: abc1234..def5678
```

## Migration

### Breaking changes（一括）

1. `~/.qult/qult.db` 削除（`/qult:uninstall` 案内、ユーザーは現状単独）
2. `archive_plan` MCP tool → `archive_spec` 改名（既存呼び出しコードはなし）
3. `get_session_status` MCP tool → `get_project_status` 改名（rules / skills の呼び出しは一斉更新）
4. `plan-generator` / `plan-evaluator` agent ファイル削除、`spec-generator` / `spec-clarifier` / `spec-evaluator` 新設
5. `/qult:plan-generator` skill 削除、`/qult:spec` 新設
6. `qult-plan-mode.md` rule 削除、`qult-spec-mode.md` 新設
7. SQLite ベースの `src/state/db.ts` / `audit-log.ts` / `flush.ts` 削除

### 互換性レイヤー

提供しない（clean break）。

### CLAUDE.md 更新

`/Users/shunichi/Projects/qult/CLAUDE.md` の以下セクションを書き換え:
- 「Rules (5 ファイル)」: plan-mode → spec-mode
- 「MCP Server」: tool 一覧を新ラインナップに
- 「Reviewer モデル」: plan-evaluator → spec-evaluator
- 「TDD」: spec の `Verify:` フィールド言及

## Testing 戦略

### 単体テスト

- markdown parser/writer の round-trip テスト（parse → modify → write → re-parse で同一）
- atomic write の crash safety（部分書き込み後の状態が valid）
- spec-evaluator の scoring（fixture 入力に対し期待スコアが出る）

### 統合テスト

- spec lifecycle 全体（init → spec → clarify → wave-start → wave-complete × N → finish）の e2e
- Wave 完了時の commit range が `git log` と一致する
- archive 後に `/qult:status archive` で旧 spec が見える

### Detector 互換テスト

- 既存 detector のテストは parser 変更後も pass する
- pending-fixes の severity ベース block が wave-complete でテストされる

## ビルド・配布

### bun build

`build.ts` の出力先は変わらず `plugin/dist/mcp-server.mjs`。新規 `src/mcp-tools/` は entry point から transitive に bundle される。

### npm dependencies

ゼロ維持。bun:sqlite を import している箇所は全削除（`src/state/db.ts` 削除で完結）。

### plugin marketplace 更新

`.claude-plugin/marketplace.json` と `plugin/.claude-plugin/plugin.json` のバージョンを v1.0.0 に bump。

## リスク

- **Markdown parser の壊れやすさ**: ユーザーが手で tasks.md を書き換えた場合に parser が落ちる可能性。緩和: 各 task 行を独立してパース、Wave ヘッダーが見つからない箇所はスキップ、エラー時は元ファイルを破壊しない（atomic write）。
- **archive_spec 移動の git 操作**: rename を `git mv` 相当でやるか単なる mv + add でやるか。git の rename detection は閾値次第なので、`git mv` を使う方が確実。
- **`/qult:wave-complete` の実装複雑度**: テスト実行 + detector + commit message 生成 + commit + wave-NN.md 更新 が 1 skill 内。失敗時のリカバリ手順を明確にする（途中失敗時は中間状態を残し、再実行可能とする）。
- **既存テストスイートの大幅書き換え**: state テストはほぼ全書き換え。Wave 数が多いと総書き換え量が大きい。Wave 設計時に test 移行を独立 Wave として分離する。

## Alternatives Considered

- **SQLite を残し markdown は薄い view にする案**: 却下。state の dual source of truth が同期ズレを起こす。哲学「軽い方を選ぶ」と矛盾。
- **per-phase evaluator 分離（spec-evaluator を 3 agent に分割）**: 却下。agent 数が増え、共通プロンプトの重複が大きい。phase 引数による単一 agent で十分。
- **`/qult:wave-start` を skill ではなく `/qult:wave-complete` 内部で自動判定する案**: 却下。明示的な区切りがあった方がユーザーが Wave の境界を意識できる。
- **EARS の 100% 強制（prose 禁止）**: 却下。User Stories や Out of Scope は prose の方が書きやすく、レビュアーも読みやすい。
- **Wave 中の自動 review**: 却下。token コストが過大、Wave 完了基準を test pass + detector に絞る方が軽い。
