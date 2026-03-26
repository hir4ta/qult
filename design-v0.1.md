# alfred v0.1.0 設計書

Claude Code の性能を倍増させる執事。13 Hooks + Skill + Agent。

## 思想

**リサーチが示した3つの変数だけに集中する:**

1. **タスクサイズ制御** — 15 LOC以下・単一ファイルに保つ (80%+ 成功率)
2. **コンテキストの質** — 必要最小限の情報だけ注入 (少ない方が強い)
3. **検証ループ** — 「何を検証すべきか」を伝える (HOWではなくWHAT)

**やらないこと:** 知識DB, ベクトル検索, 品質スコア, TUI, MCP, Convention/Security/Layer チェック

## アーキテクチャ

```
alfred CLI (init / hook / doctor)
    │
    ├── alfred init
    │   └── ~/.claude/ に 13 hooks, skill, agent, rules を配置
    │
    └── alfred hook <event>
        └── stdin JSON → 処理 → stdout JSON or exit 2
```

## Hook 一覧 (13 handlers)

### 壁 (機械的品質強制)

| Hook | 強制レベル | 役割 |
|---|---|---|
| **PostToolUse** | additionalContext | Edit/Write 後に lint/type gate 実行。失敗→pending-fixes 書込。Bash 失敗2回連続→/clear 提案。git commit 後に on_commit gate + pace リセット |
| **PreToolUse** | **DENY (exit 2)** | pending-fixes 未修正で他ファイル Edit → DENY。Pace red zone → DENY |

### Plan 増幅 (設計の質を保証)

| Hook | 強制レベル | 役割 |
|---|---|---|
| **UserPromptSubmit** | additionalContext | Plan mode → タスク分解テンプレート注入 (1ファイル/15行/Verify/[pending] status + Review Gates)。通常モード → 大タスク検出→Plan 提案 |
| **PermissionRequest** | **DENY (exit 2)** | ExitPlanMode 時に Plan ファイルを読み、Review Gates がなければ DENY |
| **TaskCompleted** | additionalContext | Claude がタスク完了マーク → Plan の該当タスクを [done] に自動書き換え (fuzzy match) |

### 実行ループ (完了の質を保証)

| Hook | 強制レベル | 役割 |
|---|---|---|
| **Stop** | **block (exit 2)** | pending-fixes 残存 → block。Plan 未完了タスク → block。Pace 20分超 → 警告。stop_hook_active で無限ループ防止 |
| **PreCompact** | state保存 | 構造化ハンドオフ保存 (summary, changed_files, pending_fixes, next_steps) |
| **SessionStart** | additionalContext | .alfred 自動作成 + gates.json 自動検出 + ハンドオフ復元→消費 |
| **SessionEnd** | state保存 | 割り込み終了含む全終了時にハンドオフ保存 (Stop の補完) |

### サブエージェント制御 (品質ルール伝搬)

| Hook | 強制レベル | 役割 |
|---|---|---|
| **SubagentStart** | additionalContext | 全サブエージェントに品質ルール + pending-fixes警告 + alfred-quality.md を注入 |
| **SubagentStop** | (拡張ポイント) | サブエージェント完了時検証。現在は pass-through |

### 自己防御

| Hook | 強制レベル | 役割 |
|---|---|---|
| **PostToolUseFailure** | additionalContext | ツールクラッシュ/timeout 追跡。2回連続同じエラー → /clear 提案 |
| **ConfigChange** | **DENY (exit 2)** | user_settings 変更を DENY (hook 削除防止) |

## Plan テンプレート

UserPromptSubmit で注入。status タグ付き:

```
## Context
Why this change is needed — problem, trigger, intended outcome.

## Tasks
Each task MUST:
- Change only 1 file
- Be under 15 lines of diff
- Specify a verification test (file:function)
- Include a status tag: [pending], [in-progress], or [done]

### Task N: <name> [pending]
- **File**: <path>
- **Change**: <what to do, behavior-focused>
- **Verify**: <test file : test function>
- **Boundary**: <what NOT to do>

IMPORTANT: Update each task's status tag to [done] as you complete it.
The Stop hook will block if any tasks remain [pending] or [in-progress].

## Review Gates
- [ ] Design Review: before starting implementation, run /alfred:review on this plan
- [ ] Phase Review: after every 3 tasks, run /alfred:review on the diff
- [ ] Final Review: after all tasks, run /alfred:review on all changes
```

## /alfred:review Skill

マルチエージェントレビュー。3つの視点から独立してレビューし、Judge がフィルタリング。

### 視点
1. **correctness**: ロジック・エッジケース・テスト漏れ
2. **design**: シンプルさ・凝集度・依存方向
3. **security**: 入力検証・機密情報・インジェクション

### Judge 基準 (HubSpot パターン)
- **Succinctness**: 簡潔で要点を突いているか
- **Accuracy**: 技術的に正しいか (コードベースのコンテキストで)
- **Actionability**: 具体的な修正提案があるか

## Gates (lint/type 実行)

`.alfred/gates.json` — `alfred init` が自動検出して生成。

```json
{
  "on_write": {
    "lint": { "command": "biome check {file} --no-errors-on-unmatched", "timeout": 3000 },
    "typecheck": { "command": "tsc --noEmit", "timeout": 10000, "run_once_per_batch": true }
  },
  "on_commit": {
    "test": { "command": "bunx --bun vitest --changed --reporter=verbose", "timeout": 30000 }
  }
}
```

## 状態ファイル

```
.alfred/
├── gates.json                  # CI風ゲート設定 (git管理)
└── .state/                     # 一時状態 (gitignore)
    ├── pending-fixes.json      # 未修正 lint/type エラー
    ├── session-pace.json       # Pace 追跡 (最終コミット時刻, 変更ファイル数)
    ├── handoff.json            # 構造化ハンドオフ
    └── fail-count.json         # 連続失敗カウント
```

## init が配置するファイル

### ~/.claude/settings.json (13 hooks)
```json
{
  "hooks": {
    "PostToolUse": [{"type": "command", "command": "alfred hook post-tool", "timeout": 5000}],
    "PreToolUse": [{"type": "command", "command": "alfred hook pre-tool", "timeout": 3000}],
    "UserPromptSubmit": [{"type": "command", "command": "alfred hook user-prompt", "timeout": 10000}],
    "SessionStart": [{"type": "command", "command": "alfred hook session-start", "timeout": 5000}],
    "Stop": [{"type": "command", "command": "alfred hook stop", "timeout": 5000}],
    "PreCompact": [{"type": "command", "command": "alfred hook pre-compact", "timeout": 10000}],
    "PermissionRequest": [{"type": "command", "command": "alfred hook permission-request", "timeout": 5000, "matcher": "ExitPlanMode"}],
    "TaskCompleted": [{"type": "command", "command": "alfred hook task-completed", "timeout": 5000}],
    "SubagentStart": [{"type": "command", "command": "alfred hook subagent-start", "timeout": 3000}],
    "SubagentStop": [{"type": "command", "command": "alfred hook subagent-stop", "timeout": 5000}],
    "PostToolUseFailure": [{"type": "command", "command": "alfred hook post-tool-failure", "timeout": 3000}],
    "SessionEnd": [{"type": "command", "command": "alfred hook session-end", "timeout": 3000}],
    "ConfigChange": [{"type": "command", "command": "alfred hook config-change", "timeout": 3000}]
  }
}
```

### ~/.claude/skills/alfred-review/SKILL.md
### ~/.claude/agents/alfred-reviewer.md
### ~/.claude/rules/alfred-quality.md

## v0.2 設計

### 1. doctor コマンド (実装済み)

`alfred doctor` — セットアップの健全性チェック。8項目を `runChecks()` で検証。
`src/doctor.ts` に実装。17テスト + Scenario 23。

### 2. run_once_per_batch

**問題:** tsc は全ファイルを型チェックする。ファイルA を編集 → tsc 実行 (10s) → ファイルB を編集 → また tsc 実行 (10s)。同じバッチ（同一応答ターン内）で2回走るのは無駄。

**設計:**
- `.alfred/.state/gate-batch.json` に `{ "typecheck": { "last_run": "ISO timestamp", "batch_id": "session_id:turn" } }` を保存
- PostToolUse の gate 実行時、`run_once_per_batch: true` のゲートは:
  1. `gate-batch.json` を読む
  2. 同じ `batch_id` で既に実行済みなら skip
  3. 未実行なら実行して `batch_id` を記録
- `batch_id` は `session_id` (HookEvent から取得) をキーにする。session_id が変わるとリセット。
- git commit 時にもリセット

**影響ファイル:**
- `src/hooks/post-tool.ts` — gate 実行前に batch チェック追加
- `src/state/gate-batch.ts` — 新規: batch state 管理
- `src/gates/runner.ts` — 変更なし (runner は単純にコマンド実行するだけ)

### 3. SubagentStop 検証強化

**問題:** 現在の `subagent-stop.ts` は pass-through。サブエージェントが不完全な出力をしても素通りする。

**設計:**
- `agent_transcript_path` フィールド (SubagentStop の入力) からサブエージェントの会話ログを読む
- `last_assistant_message` フィールドでサブエージェントの最終出力を取得
- Plan subagent の場合: 最終出力に Plan テンプレートの必須セクション (## Tasks, ## Review Gates) が含まれるか検証
- Review subagent の場合: 最終出力に findings 形式 (`[severity] file:line`) が含まれるか検証
- 不合格なら `decision: "block"` で差し戻し

**注意:** `agent_type` フィールドで Plan/Review を区別する必要がある。matcher を使って特定の agent_type のみフックすることも可能。

**影響ファイル:**
- `src/hooks/subagent-stop.ts` — 検証ロジック追加

### 4. dogfooding で発見した問題の修正 (動的)

v0.2 の実装を alfred 自身のハーネスで行う (dogfooding)。その過程で発見された問題を修正する。

予想される問題:
- ConfigChange が過剰に DENY する (settings 以外の変更も巻き込む等)
- PostToolUse の gate が遅すぎてタイムアウトする
- Plan テンプレートが長すぎて Claude が省略する
- pending-fixes のパスマッチングが本番環境で一致しない
- SubagentStart の品質ルール注入が重すぎてサブエージェントが無視する

### 5. テスト・シミュレーション方針

- 各機能にユニットテスト + シミュレーションシナリオを追加
- dogfooding 中に発見した問題は再現テストを先に書いてから修正
- 全テスト通過後にコミット
