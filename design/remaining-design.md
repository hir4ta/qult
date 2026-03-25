# alfred v1 — TUI / Rules / Skills / Agents / init 設計

---

## 1. TUI 設計

### コンセプト

**品質ダッシュボード** — alfred の壁が機能しているかをリアルタイムで可視化。
ユーザーが「alfred が効いているか」を一目で判断できる。

### レイアウト

```
┌─ alfred ─────────────────────────────────────────────────┐
│  Quality Score: 82/100  ▲ (+5 from last session)         │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
├──────────────────────────────────────────────────────────┤
│  Gates          Pass  Fail  Rate                         │
│  on_write       14    3     82%  ████████░░              │
│  on_commit      5     1     83%  ████████░░              │
│  test           8     2     80%  ████████░░              │
├──────────────────────────────────────────────────────────┤
│  Knowledge                                               │
│  error_resolution  hits: 4/6 (67%)  total: 23            │
│  exemplar          injected: 7      total: 12            │
│  convention        adherence: 91%   total: 8             │
├──────────────────────────────────────────────────────────┤
│  Recent Events                                           │
│  10:32  ✓ gate_pass  lint   src/hooks/pre-tool.ts        │
│  10:31  ✗ gate_fail  type   src/store/knowledge.ts       │
│  10:30  ✓ gate_pass  test   vitest --changed             │
│  10:28  ● error_hit  ECONNREFUSED → resolution applied   │
│  10:25  ✓ gate_pass  lint   src/mcp/server.ts            │
│  10:22  ○ error_miss  Module not found (no resolution)   │
├──────────────────────────────────────────────────────────┤
│  Session: 47min │ Files: 12 │ Commits: 3                 │
│  [q] quit  [r] refresh  [s] score detail                 │
└──────────────────────────────────────────────────────────┘
```

### セクション

| セクション | 内容 | データソース |
|---|---|---|
| **Quality Score** | セッション品質スコア 0-100 + 前セッション比較 | quality_events 集計 |
| **Gates** | on_write / on_commit / test の pass/fail/rate | quality_events |
| **Knowledge** | error_resolution ヒット率、exemplar 注入数、convention 遵守率 | quality_events |
| **Recent Events** | 直近の壁チェック結果ストリーム (最新10件) | quality_events (リアルタイム) |
| **Session Info** | 経過時間、変更ファイル数、コミット数 | git + タイマー |

### 技術スタック

- OpenTUI + @opentui/react (現在と同じ)
- Gruvbox Material Dark パレット (維持)
- データ: quality_events テーブルをポーリング (1s 間隔)
- 起動: `alfred tui`

### キーバインド

| キー | アクション |
|---|---|
| `q` | 終了 |
| `r` | リフレッシュ |
| `s` | スコア詳細表示（breakdown） |
| `e` | error_resolution 一覧表示 |
| `c` | convention 一覧表示 |
| `↑↓` | Recent Events スクロール |

### カラー

| 要素 | 色 | Gruvbox |
|---|---|---|
| gate_pass | 緑 | `#a9b665` |
| gate_fail | 赤 | `#ea6962` |
| error_hit | 水色 | `#89b482` |
| error_miss | オレンジ | `#e78a4e` |
| convention pass | 緑 | `#a9b665` |
| convention warn | 黄 | `#d8a657` |
| score 高 (80+) | 緑 | `#a9b665` |
| score 中 (60-79) | 黄 | `#d8a657` |
| score 低 (<60) | 赤 | `#ea6962` |

---

## 2. Rules 設計

### 配置場所

```
~/.claude/rules/
  alfred-quality.md      # 品質ルール（全プロジェクト共通）
```

プロジェクト固有:
```
.claude/rules/
  alfred-conventions.md  # Convention から自動生成（プロジェクト固有）
```

### ~/.claude/rules/alfred-quality.md

```markdown
---
description: alfred quality enforcement rules — applied to all projects
---

# Quality Rules

## Test First
- When implementing a new function or module, write the test file FIRST
- Test file must have at least 2 meaningful assertions per test case
- Do not mark implementation as complete until tests pass

## Error Handling
- Check function return values explicitly — do not silently ignore errors
- Prefer early return over deeply nested if/else
- Never catch errors just to log them — either handle or re-throw

## Code Changes
- Keep each logical change under 200 lines of diff
- If a change exceeds 200 lines, split into smaller commits
- Run the project's lint and type check commands after each file edit

## Self-Check Before Completion
- Before marking any task as done, verify:
  1. Are there edge cases that need tests?
  2. Could this fail silently (produce wrong output without crashing)?
  3. Is there a simpler approach?
  4. Does this follow the project's existing patterns?

## When Stuck
- If the same approach fails 3 times, stop and research:
  1. Check official documentation
  2. Search for similar issues on GitHub/StackOverflow
  3. Try a fundamentally different approach
```

### .claude/rules/alfred-conventions.md (自動生成)

`/alfred:conventions` スキル実行後、または `alfred init --scan` で生成:

```markdown
---
description: Project-specific conventions discovered by alfred
paths:
  - "src/**/*"
---

# Project Conventions

## Error Handling
- Use early return pattern (see src/hooks/dispatcher.ts:66)
- Wrap async operations with AbortSignal support

## Testing
- Test files co-located: src/foo.ts → src/foo.test.ts
- Use vitest with describe/it/expect
- Minimum 2 assertions per test case

## Imports
- Bun builtins first (node:fs, node:path)
- External packages second
- Internal modules third (relative paths)

## Naming
- Files: kebab-case (my-module.ts)
- Functions: camelCase
- Types/Interfaces: PascalCase
- Constants: UPPER_SNAKE_CASE
```

このファイルは `paths` glob 付きなので、`src/` 以下のファイルを Claude が読んだ時のみロードされる。

---

## 3. Skills 設計

### /alfred:review — Deep マルチエージェントレビュー

```
~/.claude/skills/alfred-review/
  SKILL.md
  checklists/
    security.md
    logic.md
    design.md
    judge.md
```

#### SKILL.md

```markdown
---
name: alfred-review
description: >
  Deep multi-agent code review with Judge filtering. Use when wanting
  thorough review before a major commit, after a milestone, or when
  Claude suggests it. Spawns 3 parallel sub-reviewers (security, logic,
  design), then a Judge agent filters findings for actionability.
  NOT for everyday small edits (hooks handle that).
user-invocable: true
argument-hint: "[--staged | --commit SHA | --range BASE..HEAD]"
allowed-tools: Read, Glob, Grep, Agent, Bash(git diff *, git log *, git show *, git status *)
context: fork
---

# /alfred:review — Judge-Filtered Code Review

## Phase 1: Gather Context

1. Parse `$ARGUMENTS` for scope:
   - `--staged` (default): `git diff --cached`
   - `--commit SHA`: `git show SHA`
   - `--range BASE..HEAD`: `git diff BASE..HEAD`
2. If no args: use `git diff` (unstaged changes)
3. Extract changed file paths, languages
4. Read @checklists/security.md, @checklists/logic.md, @checklists/design.md

## Phase 2: Parallel Review (spawn 3 agents simultaneously)

Launch all 3 agents in a single message:

**Agent 1: security** — @checklists/security.md
Focus: injection, auth, secrets, TOCTOU, input validation

**Agent 2: logic** — @checklists/logic.md
Focus: correctness, edge cases, error handling, race conditions, silent failures

**Agent 3: design** — @checklists/design.md
Focus: naming, structure, duplication, complexity, conventions

Each agent returns findings as:
```
<review-finding severity="critical|high|medium|low" file="path" line="N">
Description of the issue and suggested fix.
</review-finding>
```

## Phase 3: Judge Filtering

For each finding, evaluate:
1. **Actionable?** — Can the developer fix this without ambiguity?
2. **In scope?** — Is this in the current diff, not a pre-existing issue?
3. **Real problem?** — Is this a genuine issue, not a style preference?

Discard findings that fail any criterion. Log discards with reason.

## Phase 4: Output

Present findings sorted by severity:
```
## Review Summary: X findings (Y critical, Z high)

### Critical
- [file:line] Description + suggested fix

### High
- [file:line] Description + suggested fix

### Medium (informational)
- [file:line] Description

## Score: NN/100
```

If 0 critical and 0 high: "Ready to commit."
If any critical: "Fix critical issues before committing."
```

### /alfred:conventions — Convention 自動発見

```
~/.claude/skills/alfred-conventions/
  SKILL.md
```

#### SKILL.md

```markdown
---
name: alfred-conventions
description: >
  Scan the codebase and discover implicit coding conventions.
  Use on first setup of a new project, after major refactors,
  or when wanting to document existing patterns. Saves confirmed
  conventions to .alfred/conventions.json and generates
  .claude/rules/alfred-conventions.md.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash(wc *, head *, git log --oneline *)
---

# /alfred:conventions — Convention Discovery

## Step 1: Project Analysis

Scan the codebase for patterns:

1. **Import ordering** — Read 10 representative source files. Detect grouping pattern:
   - Stdlib → external → internal? Or alphabetical? Or other?

2. **Naming conventions** — Scan file names, function names, type names:
   - Files: kebab-case? camelCase? snake_case?
   - Functions: camelCase? snake_case?
   - Types: PascalCase?
   - Constants: UPPER_SNAKE_CASE?

3. **Error handling** — Grep for try/catch, .catch, Result type, early return patterns:
   - What's the dominant pattern?

4. **Test structure** — Find test files:
   - Co-located (src/foo.test.ts) or separate (__tests__/)?
   - Naming: .test. or .spec.?
   - Framework: describe/it/expect? test()?

5. **Directory structure** — ls top-level dirs:
   - Feature-based or layer-based?

6. **Code style** — Check for config files:
   - biome.json? .eslintrc? .prettierrc?
   - What rules are configured?

## Step 2: Present Findings

Present each discovered convention with:
- Pattern description
- Example files (3 examples each)
- Confidence: high (>80% of files follow) / medium (50-80%) / low (<50%)

Ask user to confirm/reject each convention.

## Step 3: Save

For confirmed conventions:
1. Call `alfred save type=convention` for each
2. Generate `.claude/rules/alfred-conventions.md` with path-scoped rules
3. Report: "Saved N conventions. Rules file generated."
```

---

## 4. Agents 設計

### alfred-reviewer.md

```
~/.claude/agents/alfred-reviewer.md
```

```markdown
---
name: alfred-reviewer
description: >
  Single-perspective code reviewer. Used as a sub-agent by /alfred:review.
  Focuses on one review dimension (security, logic, or design).
  Returns structured findings. Never spawns sub-agents itself.
tools: Read, Glob, Grep, Bash(git diff *, git show *)
disallowedTools: Write, Edit, Agent
permissionMode: plan
maxTurns: 15
---

You are a focused code reviewer. You receive a diff and a checklist.
Review ONLY the diff — do not flag pre-existing issues.

Output each finding as:
<review-finding severity="critical|high|medium|low" file="path" line="N">
Issue description. Suggested fix.
</review-finding>

If no issues found, output:
<review-finding severity="none">No issues found in this review dimension.</review-finding>
```

---

## 5. `alfred init` 設計

### コマンド

```
alfred init [--scan] [--force]
```

- `--scan`: プロジェクトの convention 自動スキャンも実行
- `--force`: 既存の設定を上書き

### 実行フロー

```
alfred init
  ↓
① バイナリパスの確認
   alfred 自身のパスを取得 (process.execPath)
  ↓
② ~/.claude/.mcp.json に MCP サーバー登録
   "alfred" エントリを追加（既存なら上書き確認）
   {
     "mcpServers": {
       "alfred": {
         "type": "stdio",
         "command": "/path/to/alfred",
         "args": ["mcp"],
         "env": { "VOYAGE_API_KEY": "${VOYAGE_API_KEY}" }
       }
     }
   }
  ↓
③ ~/.claude/settings.json に hooks 追加
   hooks セクションに 6 hooks を登録（既存の hooks はマージ）
   ※ 既存の alfred hooks があれば置換
  ↓
④ ~/.claude/rules/alfred-quality.md を配置
   品質ルールファイルを書き込み
  ↓
⑤ ~/.claude/skills/alfred-review/ を配置
   SKILL.md + checklists/ を書き込み
  ↓
⑥ ~/.claude/skills/alfred-conventions/ を配置
   SKILL.md を書き込み
  ↓
⑦ ~/.claude/agents/alfred-reviewer.md を配置
   エージェント定義を書き込み
  ↓
⑧ プロジェクト設定（cwd に .alfred/ があれば）
   .alfred/.state/ ディレクトリ作成
   .alfred/gates.json 自動生成（package.json 等から検出）
   .alfred/conventions.json 初期化（空）
  ↓
⑨ --scan オプション時
   convention スキャン実行
   → .alfred/conventions.json に保存
   → .claude/rules/alfred-conventions.md 生成
  ↓
⑩ DB 初期化
   ~/.alfred/alfred.db に Schema V1 を作成（なければ）
   プロジェクト登録 (resolveOrRegisterProject)
  ↓
完了メッセージ:
  alfred initialized.
  - MCP server: ~/.claude/.mcp.json
  - Hooks: ~/.claude/settings.json (6 hooks)
  - Rules: ~/.claude/rules/alfred-quality.md
  - Skills: /alfred:review, /alfred:conventions
  - Agent: alfred-reviewer
  - Gates: .alfred/gates.json
  - DB: ~/.alfred/alfred.db
```

### ファイル配置まとめ

```
~/.claude/                           ← alfred init が書き込み
├── .mcp.json                        ← MCP サーバー登録
├── settings.json                    ← hooks 定義追加
├── rules/
│   └── alfred-quality.md            ← 品質ルール
├── skills/
│   ├── alfred-review/
│   │   ├── SKILL.md                 ← レビュースキル
│   │   └── checklists/
│   │       ├── security.md
│   │       ├── logic.md
│   │       ├── design.md
│   │       └── judge.md
│   └── alfred-conventions/
│       └── SKILL.md                 ← Convention 発見スキル
└── agents/
    └── alfred-reviewer.md           ← レビュー用サブエージェント

~/.alfred/                           ← alfred のデータ
└── alfred.db                        ← SQLite DB (知識 + 品質イベント)

<project>/
├── .alfred/                         ← プロジェクト固有
│   ├── gates.json                   ← CI スタイルゲート定義
│   ├── conventions.json             ← Convention データ
│   ├── knowledge/                   ← 知識ファイル (git 共有)
│   │   ├── error_resolutions/
│   │   ├── exemplars/
│   │   └── conventions/
│   └── .state/                      ← 状態ファイル (gitignore)
│       ├── project-profile.json
│       ├── pending-fixes.json
│       ├── session-summary.json
│       └── chapter.json
└── .claude/
    └── rules/
        └── alfred-conventions.md    ← Convention から自動生成
```

### alfred uninstall

```
alfred uninstall [--keep-data]
```

- ~/.claude/settings.json から hooks 削除
- ~/.claude/.mcp.json から alfred エントリ削除
- ~/.claude/rules/alfred-quality.md 削除
- ~/.claude/skills/alfred-review/ 削除
- ~/.claude/skills/alfred-conventions/ 削除
- ~/.claude/agents/alfred-reviewer.md 削除
- `--keep-data` なし: ~/.alfred/ と .alfred/ も削除

---

## 6. CLI コマンド全体

```
alfred init [--scan] [--force]    # セットアップ
alfred uninstall [--keep-data]    # アンインストール
alfred mcp                        # MCP サーバー起動 (stdio)
alfred hook <event>               # Hook ハンドラ
alfred hook-internal <subcommand> # 内部コマンド (agent hook から呼ばれる)
alfred tui                        # TUI 起動
alfred doctor                     # ヘルスチェック
alfred version                    # バージョン表示
```

### alfred doctor

```
alfred doctor

  ✓ Binary: /usr/local/bin/alfred v2.0.0
  ✓ DB: ~/.alfred/alfred.db (Schema V1)
  ✓ MCP: ~/.claude/.mcp.json (alfred registered)
  ✓ Hooks: ~/.claude/settings.json (6 hooks registered)
  ✓ Rules: ~/.claude/rules/alfred-quality.md
  ✓ Skills: alfred-review, alfred-conventions
  ✓ Agent: alfred-reviewer
  ✓ Voyage AI: VOYAGE_API_KEY set, API reachable
  ✓ Project: .alfred/ found, gates.json valid
  ✓ Conventions: 8 active conventions
  ✓ Knowledge: 23 error_resolutions, 12 exemplars
```
