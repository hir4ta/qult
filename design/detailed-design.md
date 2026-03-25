# alfred v1 — Hook & MCP 詳細設計

## Hook アーキテクチャ

### データフロー概要

```
Claude Code のアクション
  ↓
Hook イベント発火 (Claude Code → alfred CLI via stdin JSON)
  ↓
alfred hook <event> が処理
  ↓
stdout JSON で応答 (additionalContext, permissionDecision 等)
  ↓
Claude Code がレスポンスを解釈して行動
```

### stdin 入力スキーマ（Claude Code が送る）

```typescript
// 全イベント共通
interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  permission_mode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  stop_hook_active?: boolean;
}

// PreToolUse / PostToolUse 追加フィールド
interface ToolHookInput extends HookInput {
  tool_name: string;          // "Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent"
  tool_input: {
    command?: string;          // Bash
    file_path?: string;        // Edit/Write/Read
    old_string?: string;       // Edit
    new_string?: string;       // Edit
    content?: string;          // Write
    pattern?: string;          // Grep/Glob
  };
  tool_response?: {            // PostToolUse のみ
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    content?: string;          // Read/Edit/Write result
  };
}

// UserPromptSubmit 追加フィールド
interface PromptHookInput extends HookInput {
  prompt: string;              // ユーザーの入力テキスト
}

// SessionStart 追加フィールド
interface SessionHookInput extends HookInput {
  source: "startup" | "resume" | "clear" | "compact";
}
```

### stdout 出力スキーマ（alfred が返す）

```typescript
// 基本出力
interface HookOutput {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext?: string;           // Claude のコンテキストに注入
    permissionDecision?: "allow" | "deny" | "ask";  // PreToolUse のみ
    permissionDecisionReason?: string;    // deny/allow の理由
  };
}

// ブロック時は exit code 2 + stderr にメッセージ
// 許可時は exit code 0 + stdout に JSON
```

---

## Hook 詳細設計（6 hooks）

---

### 1. PreToolUse (3s タイムアウト)

**役割**: 品質の壁。Edit/Write をブロックできる唯一の Hook。

**matcher**: `Edit|Write` （Bash, Read 等はスルー）

#### フロー

```
Edit/Write が呼ばれようとしている
  ↓
alfred hook pre-tool-use が stdin から JSON を読む
  ↓
① pending-fixes チェック
   .alfred/.state/pending-fixes.json を読む
   → 未修正の lint/type エラーがある？
   → YES: exit 2 + stderr にエラー内容 → Claude Code が DENY
   → NO: 次へ
  ↓
② convention チェック
   対象ファイルのディレクトリに対応する convention を検索
   → あれば additionalContext に CONTEXT として注入
  ↓
③ テスト隣接チェック
   対象ファイルが src/**/*.ts 等のソースファイル？
   → 対応テストファイル (*.test.ts 等) が存在しない？
   → WARNING を additionalContext に追加
  ↓
exit 0 + JSON stdout (additionalContext + permissionDecision: "allow")
```

#### 状態ファイル: `.alfred/.state/pending-fixes.json`

```json
{
  "files": {
    "src/hooks/pre-tool.ts": {
      "lint": [
        { "line": 15, "rule": "no-unused-vars", "message": "Variable 'x' is declared but never used" }
      ],
      "type": [
        { "line": 22, "message": "Type 'string' is not assignable to type 'number'" }
      ]
    }
  },
  "updated_at": "2026-03-26T10:30:00Z"
}
```

#### PreToolUse の出力例

**DENY (未修正エラーあり)**:
```
// exit code 2
// stderr:
Fix lint/type errors before editing more files:
- src/hooks/pre-tool.ts:15 — no-unused-vars: Variable 'x' is declared but never used
- src/hooks/pre-tool.ts:22 — Type 'string' is not assignable to type 'number'
```

**ALLOW + コンテキスト注入**:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "[CONTEXT] Convention for src/hooks/: error handling uses early return pattern. See src/hooks/dispatcher.ts:66 for example.\n[WARNING] No test file found for src/hooks/pre-tool.ts. Consider creating src/hooks/pre-tool.test.ts."
  }
}
```

---

### 2. PostToolUse (5s タイムアウト)

**役割**: 検出 + DIRECTIVE 注入 + 状態更新。ブロックはできない。

**matcher**: `Bash|Edit|Write` （Read, Grep, Glob はスルー）

#### フロー: Edit/Write 後

```
Edit/Write が完了した
  ↓
alfred hook post-tool-use が stdin から JSON を読む
  ↓
① 対象ファイルのパスを取得 (tool_input.file_path)
  ↓
② lint チェック実行 (3s タイムアウト)
   gates.json の on_write コマンドを対象ファイルに対して実行
   例: biome check src/hooks/pre-tool.ts --no-errors-on-unmatched
   例: tsc --noEmit (プロジェクト全体だが高速)
  ↓
③ 結果を .alfred/.state/pending-fixes.json に保存
  ↓
④ エラーあり？
   → YES: DIRECTIVE を additionalContext で注入
          "Fix the following lint/type errors before continuing: ..."
   → NO: pending-fixes.json をクリア
  ↓
⑤ quality_event を DB に記録 (gate_pass or gate_fail)
```

#### フロー: Bash 後（テスト実行）

```
Bash が完了 + exitCode が返ってきた
  ↓
① テストコマンドか判定
   stdout/command に vitest|jest|pytest|go test|cargo test を検出
  ↓
② テスト失敗？
   → YES:
     a. 失敗テスト名 + エラーメッセージを抽出
     b. error_resolution をベクトル検索 (Voyage)
     c. ヒット → additionalContext に解決策を CONTEXT 注入
     d. ミス → quality_event に error_miss 記録
   → NO (テスト成功):
     a. アサーション品質チェック (アサーション数パース)
     b. 密度 < 2 → WARNING
     c. quality_event に gate_pass 記録
  ↓
③ テストコマンドでない Bash 失敗？
   → error_resolution をベクトル検索
   → ヒット → CONTEXT で解決策注入
   → ミス → 何もしない (Claude の通常デバッグに任せる)
```

#### フロー: Bash 後（git commit）

```
Bash 完了 + stdout に git commit を検出
  ↓
① gates.json の on_commit コマンドを実行
   例: vitest --changed --reporter=verbose
   例: tsc --noEmit
  ↓
② 失敗？ → DIRECTIVE: "Commit gate failed. Fix before continuing."
③ 成功？ → quality_event に gate_pass 記録
```

#### PostToolUse の出力例

**Edit 後 lint エラー**:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "[DIRECTIVE] Fix lint errors in the file you just edited:\n- src/foo.ts:15 — no-unused-vars: Variable 'x' is unused\n- src/foo.ts:22 — Type error: string is not assignable to number"
  }
}
```

**Bash エラー + 知識ヒット**:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "[CONTEXT] Similar error resolved before: \"ECONNREFUSED on port 5432\" — Resolution: Check if PostgreSQL is running with `pg_isready`. If not, start with `brew services start postgresql`."
  }
}
```

**テスト成功 + 弱いアサーション**:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "[WARNING] Test src/foo.test.ts has only 1 assertion. Consider adding edge case assertions (minimum 2 recommended)."
  }
}
```

---

### 3. UserPromptSubmit (10s タイムアウト)

**役割**: Plan mode パワーアップ + 知識注入

**matcher**: なし（全プロンプト）

#### フロー

```
ユーザーがプロンプトを送信
  ↓
alfred hook user-prompt-submit が stdin から JSON を読む
  ↓
① Plan mode / 実装計画の検出
   prompt に "plan", "設計", "implement", "実装", "build" 等を検出
   → [DIRECTIVE] 注入:
     "You MUST: (1) Write tests first for each component.
      (2) Define acceptance criteria before implementing.
      (3) Keep each task under 200 lines of changes."
  ↓
② 知識検索 (Voyage ベクトル検索)
   prompt をクエリとして error_resolution + exemplar を検索
   → 関連度 >= 0.80 のエントリがあれば CONTEXT 注入 (最大2件)
   → hit_count を更新
  ↓
③ convention 矛盾チェック
   prompt が convention に矛盾するアプローチを示唆していないか
   → 矛盾あり → WARNING 注入
  ↓
exit 0 + JSON stdout
```

#### 出力例

**Plan mode 検出 + 知識ヒット**:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "[DIRECTIVE] You MUST: (1) Write tests first for each component (2) Define acceptance criteria before implementing (3) Keep each task under 200 lines of changes\n\n[CONTEXT] Related pattern: When working with bun:sqlite, always use `db.prepare()` instead of `db.exec()` for parameterized queries. Example: db.prepare('SELECT * FROM t WHERE id = ?').get(id)"
  }
}
```

---

### 4. SessionStart (5s タイムアウト)

**役割**: 初期コンテキスト注入 + プロジェクトプロファイリング

**matcher**: なし

#### フロー

```
セッション開始
  ↓
① プロジェクトプロファイル確認
   .alfred/.state/project-profile.json が存在する？
   → NO (初回): プロジェクトスキャン実行
     - package.json → 言語, テストFW, リンター検出
     - tsconfig.json → TypeScript 設定
     - Taskfile / Makefile → ビルドコマンド
     → project-profile.json に保存
   → YES: 読み込み
  ↓
② 前セッション品質サマリー注入
   .alfred/.state/session-summary.json を読む
   → あれば CONTEXT 注入: "前セッション: gate_pass 12/15 (80%), error_resolution hit 3/5"
  ↓
③ conventions 注入
   .alfred/conventions.json を読む
   → 主要 convention を CONTEXT 注入 (最大5件, 行数制限)
  ↓
④ 知識同期 (DB)
   .alfred/knowledge/ の JSON ファイルを DB に同期
  ↓
exit 0 + JSON stdout
```

#### 出力例

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "[CONTEXT] Project: TypeScript (Bun 1.3+), test: vitest, lint: biome, build: bun build\n[CONTEXT] Previous session quality: gate pass rate 80% (12/15), 3 error resolutions used\n[CONTEXT] Conventions: (1) Error handling: early return pattern (2) Test files: co-located *.test.ts (3) Imports: bun builtins first, then external"
  }
}
```

---

### 5. PreCompact (10s タイムアウト)

**役割**: セッション学習抽出 + 品質サマリー保存

**matcher**: なし

#### フロー

```
コンパクション発生
  ↓
① Agent Hook (並列、Haiku)
   transcript を読んで意思決定を抽出
   → alfred hook-internal save-decision で DB 保存
  ↓
② Command Hook (本体)
   a. 品質サマリー計算
      quality_events テーブルから当セッションの集計:
      - gate_pass / gate_fail カウント
      - error_hit / error_miss カウント
      - 変更ファイル数
      → .alfred/.state/session-summary.json に保存
   b. error_resolution 自動抽出
      セッション中の Bash error → 後続の成功パターンを検出
      → 新しい error_resolution として DB 保存
   c. chapter memory
      現在の作業状態を .alfred/.state/chapter.json に保存:
      - 何をやっていたか (最後のプロンプト要約)
      - 変更ファイルリスト
      - 未解決の壁 (pending-fixes)
      - 次にやるべきこと
  ↓
exit 0
```

---

### 6. Stop (3s タイムアウト)

**役割**: ソフトリマインダー（ブロックも可能だが控えめに）

**matcher**: なし

#### フロー

```
Claude が停止しようとしている
  ↓
① 未テスト変更チェック
   git diff --name-only で変更ファイル取得
   対応テストファイルが変更されていないソースファイルがある？
   → YES: CONTEXT 注入 "Changed files without test updates: src/foo.ts"
  ↓
② pending-fixes チェック
   .alfred/.state/pending-fixes.json にエラーが残っている？
   → YES: WARNING 注入 "Unresolved lint/type errors remain"
  ↓
③ 品質サマリー保存
   quality_events から当セッンの最終サマリーを計算・保存
  ↓
exit 0 + JSON stdout (ブロックしない、CONTEXT のみ)
```

---

### Self-Reflection プロトコル

PostToolUse で **タスク完了** を検出した時に DIRECTIVE 注入。

検出方法: Claude Code の TaskCompleted イベント、または `git commit` + コミットメッセージに "complete", "done", "finish" を含む場合。

```
[DIRECTIVE] Before marking this complete, verify:
1. Edge cases — List 3 edge cases and confirm they are handled or tested
2. Silent failure — Could this produce wrong output without crashing?
3. Simplicity — Is there a simpler approach?
4. Conventions — Does this match project patterns?
```

---

## gates.json 設計

### 場所と形式

`.alfred/gates.json` (プロジェクトルート、git 共有)

```json
{
  "on_write": {
    "lint": {
      "command": "biome check {file} --no-errors-on-unmatched",
      "timeout": 3000
    },
    "typecheck": {
      "command": "tsc --noEmit",
      "timeout": 5000,
      "run_once_per_batch": true
    }
  },
  "on_commit": {
    "test_changed": {
      "command": "vitest --changed --reporter=verbose",
      "timeout": 30000
    },
    "typecheck": {
      "command": "tsc --noEmit",
      "timeout": 5000
    }
  }
}
```

### フィールド

- `{file}`: PostToolUse が変更されたファイルパスに置換
- `timeout`: ミリ秒。超えたらスキップ（fail-open）
- `run_once_per_batch`: 同一セッション内で1度だけ実行（tsc は全体チェックなので毎回不要）

### 自動生成

`alfred init` が package.json / tsconfig.json / biome.json 等から自動検出:

```typescript
function detectGates(cwd: string): GatesConfig {
  const gates: GatesConfig = { on_write: {}, on_commit: {} };

  if (exists("biome.json") || exists("biome.jsonc")) {
    gates.on_write.lint = { command: "biome check {file} --no-errors-on-unmatched", timeout: 3000 };
  } else if (exists(".eslintrc*")) {
    gates.on_write.lint = { command: "eslint {file}", timeout: 5000 };
  }

  if (exists("tsconfig.json")) {
    gates.on_write.typecheck = { command: "tsc --noEmit", timeout: 5000, run_once_per_batch: true };
  }

  if (hasDevDep("vitest")) {
    gates.on_commit.test_changed = { command: "vitest --changed --reporter=verbose", timeout: 30000 };
  } else if (hasDevDep("jest")) {
    gates.on_commit.test_changed = { command: "jest --changedSince=HEAD~1", timeout: 30000 };
  }

  return gates;
}
```

---

## MCP ツール詳細設計

### 概要

**1 ツール: `alfred`**

Claude Code が能動的に知識 DB を使いたい時のインターフェース。
Hook が受動的（自動）なのに対し、MCP は能動的（Claude が判断して呼ぶ）。

### アクション

```
alfred action=search  — 知識検索
alfred action=save    — 知識保存
alfred action=profile — プロジェクトプロファイル
alfred action=score   — 品質スコア
```

### action=search

```typescript
// 入力
{
  action: "search",
  query: string,                                    // 検索クエリ
  type?: "error_resolution" | "exemplar" | "convention" | "all",  // デフォルト: all
  scope?: "project" | "global",                     // デフォルト: project
  limit?: number,                                   // デフォルト: 5
}

// 処理
// 1. Voyage embed query
// 2. vectorSearch (cosine similarity >= 0.70)
// 3. rerank (top K)
// 4. recency signal (half-life per type)
// 5. hit_count 更新

// 出力
{
  results: [
    {
      id: number,
      type: "error_resolution" | "exemplar" | "convention",
      title: string,
      content: string,      // 型に応じた構造化テキスト
      score: number,         // 0-1
      match_reason: string,  // "semantic match" | "exact match"
      last_accessed: string, // ISO8601
      hit_count: number,
    }
  ],
  total: number,
  query_tokens: number,     // トークン消費の目安
}
```

### action=save

```typescript
// 入力
{
  action: "save",
  type: "error_resolution" | "exemplar" | "convention",
  title: string,

  // error_resolution の場合
  error_signature?: string,   // 正規化されたエラーメッセージ
  resolution?: string,        // 解決策

  // exemplar の場合
  bad?: string,               // before コード
  good?: string,              // after コード
  explanation?: string,       // なぜ good が良いか

  // convention の場合
  pattern?: string,           // 規約の説明
  category?: string,          // naming | imports | error-handling | testing | architecture | style
  example_files?: string[],   // 参考ファイルパス

  // 共通
  tags?: string[],
  project_path?: string,      // デフォルト: cwd
}

// 処理
// 1. 品質ゲート (重複検出 via Voyage, actionability check)
// 2. .alfred/knowledge/{type}s/{id}.json に書き込み (source of truth)
// 3. DB upsert (検索インデックス)
// 4. Voyage embed + insertEmbedding

// 出力
{
  id: number,
  status: "saved",
  quality_warnings?: string[],   // 重複候補等
  similar_existing?: { id: number, title: string, score: number }[],
}
```

### action=profile

```typescript
// 入力
{
  action: "profile",
  refresh?: boolean,         // true で再スキャン
  project_path?: string,
}

// 出力
{
  language: string[],        // ["typescript", "tsx"]
  runtime: string,           // "bun" | "node" | "deno"
  test_framework: string,    // "vitest" | "jest" | "pytest" | ...
  test_pattern: string,      // "*.test.ts" | "*_test.go" | ...
  linter: string,            // "biome" | "eslint" | "ruff" | ...
  build_system: string,      // "bun build" | "tsc" | "vite" | ...
  gates: GatesConfig,        // 現在の gates.json 内容
  conventions_count: number,
  knowledge_count: {
    error_resolution: number,
    exemplar: number,
    convention: number,
  },
}
```

### action=score

```typescript
// 入力
{
  action: "score",
  session_id?: string,       // 省略時は現在セッション
  project_path?: string,
}

// 出力
{
  session_score: number,     // 0-100
  breakdown: {
    gate_pass_rate_write: { score: number, pass: number, total: number },
    gate_pass_rate_commit: { score: number, pass: number, total: number },
    test_coverage_delta: { score: number, delta: string },
    error_resolution_hit: { score: number, hit: number, total: number },
    convention_adherence: { score: number, pass: number, total: number },
  },
  trend: "improving" | "stable" | "declining",
  previous_sessions: number[],  // 直近5セッションのスコア
}
```

---

## DB スキーマ (V1)

```sql
-- プロジェクト
CREATE TABLE projects (
  id TEXT PRIMARY KEY,           -- UUID v4
  name TEXT NOT NULL,
  remote TEXT,
  path TEXT,
  status TEXT DEFAULT 'active',
  registered_at TEXT,
  last_seen_at TEXT
);

-- 知識 (error_resolution, exemplar, convention)
CREATE TABLE knowledge_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('error_resolution','exemplar','convention')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,          -- JSON (型に応じた構造)
  tags TEXT,                      -- カンマ区切り
  author TEXT,
  hit_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(project_id, type, title)
);

-- ベクトル
CREATE TABLE embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'knowledge',
  source_id INTEGER NOT NULL,
  model TEXT,
  dims INTEGER,
  vector BLOB,
  created_at TEXT
);

-- 品質イベント
CREATE TABLE quality_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'gate_pass','gate_fail','error_hit','error_miss',
    'test_pass','test_fail','assertion_warning',
    'convention_pass','convention_warn'
  )),
  data TEXT,                      -- JSON (詳細データ)
  created_at TEXT
);

-- スキーマバージョン
CREATE TABLE schema_version (version INTEGER);
```

### 削除テーブル (V10 → V1)

- `spec_index` — Spec 削除
- `spec_fts` — FTS5 削除
- `knowledge_fts` — FTS5 削除
- `tag_aliases` — FTS5 用、削除

### content JSON 構造

**error_resolution**:
```json
{
  "error_signature": "ECONNREFUSED 127.0.0.1:5432",
  "resolution": "Check if PostgreSQL is running: pg_isready. Start with: brew services start postgresql",
  "context": "bun:sqlite connection failure during vitest"
}
```

**exemplar**:
```json
{
  "bad": "try { await fetch(url) } catch (e) { console.log(e) }",
  "good": "const res = await fetch(url);\nif (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);",
  "explanation": "Explicit HTTP status checking instead of try-catch around fetch. fetch() only throws on network errors, not HTTP errors."
}
```

**convention**:
```json
{
  "pattern": "Error handling uses early return pattern",
  "category": "error-handling",
  "example_files": ["src/hooks/dispatcher.ts:66", "src/store/knowledge.ts:45"]
}
```

---

## 状態ファイル (.alfred/.state/)

| ファイル | 用途 | 書き込み | 読み込み |
|---|---|---|---|
| `project-profile.json` | プロジェクト設定 (言語, テストFW, リンター) | SessionStart (初回), alfred init | 全 Hook |
| `pending-fixes.json` | 未修正の lint/type エラー | PostToolUse | PreToolUse |
| `session-summary.json` | セッション品質サマリー | PreCompact, Stop | SessionStart |
| `chapter.json` | コンパクション後の継続コンテキスト | PreCompact | SessionStart (resume) |
| `gates-cache.json` | gates.json のパース済みキャッシュ | PostToolUse (初回) | PostToolUse |

---

## hooks.json 設定 (alfred init が生成)

`~/.claude/settings.json` に書き込む:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "alfred hook pre-tool-use",
            "timeout": 3
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "alfred hook post-tool-use",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "alfred hook user-prompt-submit",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "alfred hook session-start",
            "timeout": 5
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "alfred hook pre-compact",
            "timeout": 10
          },
          {
            "type": "agent",
            "prompt": "Read the transcript and extract technical decisions made during this session. For each decision, run: alfred hook-internal save-decision --title '...' --decision '...' --reasoning '...'",
            "timeout": 60
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "alfred hook stop",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

---

## MCP 設定 (alfred init が生成)

`~/.claude/.mcp.json` に追記:

```json
{
  "mcpServers": {
    "alfred": {
      "type": "stdio",
      "command": "alfred",
      "args": ["mcp"],
      "env": {
        "VOYAGE_API_KEY": "${VOYAGE_API_KEY}"
      }
    }
  }
}
```
