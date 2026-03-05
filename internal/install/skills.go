package install
type skillDef struct {
	Dir     string // directory name under ~/.claude/skills/
	Content string // SKILL.md content
}

var alfredSkills = []skillDef{
	{
		Dir: "configure",
		Content: `---
name: configure
description: >
  Create or polish a single Claude Code configuration file (skill, rule, hook,
  agent, MCP server, CLAUDE.md, or memory) with independent review.
  For project-wide setup, use /alfred:setup instead.
user-invocable: true
argument-hint: "<type> [name]"
allowed-tools: Read, Write, Edit, Glob, Bash, Agent, AskUserQuestion, mcp__alfred__knowledge
context: current
---

The butler tends to the estate's configuration — whether building new or polishing existing.

## Steps

1. **[WHAT]** Determine target type from $ARGUMENTS:
   - Parse for type: ` + "`skill`" + `, ` + "`rule`" + `, ` + "`hook`" + `, ` + "`agent`" + `, ` + "`mcp`" + `, ` + "`claude-md`" + `, ` + "`memory`" + `
   - If type not provided or unclear, ask with AskUserQuestion
   - If name not provided, ask for it (except claude-md and memory which have fixed paths)

2. **[HOW]** Check if target file exists:
   - Glob for existing files at the target path (see Target Paths below)

3. **[HOW]** If file EXISTS (polish flow):
   - Read the current file content in full
   - Call ` + "`knowledge`" + ` with query about latest best practices for this type
   - Compare against best practices and identify gaps (type-specific):
     - **skill**: constraint tags (HOW/WHAT/Template/Guardrails), tool least-privilege, argument-hint, context choice
     - **rule**: glob patterns valid, instructions actionable, concise (<20 lines)
     - **hook**: timeout values appropriate, matchers specific, handler robust
     - **agent**: model explicit, tools minimal, description explains WHEN to delegate, maxTurns set
     - **mcp**: env vars for secrets, valid command
     - **claude-md**: <200 lines, required sections, actionable rules, copy-pasteable commands
     - **memory**: <200 lines, topic-organized, no session-specific content
   - Present proposed changes with before/after diff and ask for approval
   - Use Edit tool to apply approved changes (preserve unchanged sections)

4. **[HOW]** If file is NEW (prepare flow):
   - Gather requirements (type-specific):
     - **skill**: purpose, user-invocable flag, fork/current context, allowed-tools
     - **rule**: enforcement concept, glob patterns (e.g., ` + "`**/*.go`" + `)
     - **hook**: event type, handler purpose, blocking behavior
     - **agent**: specialization, required tools, memory type (user/project/local)
     - **mcp**: server name/npm package, server type (stdio/sse)
     - **claude-md**: detect project stack (go.mod, package.json, etc.), scan structure
     - **memory**: check auto memory path, topic organization
   - Call ` + "`knowledge`" + ` with query about the specific type's best practices
   - Generate from type-specific template:
     - **skill**: frontmatter (name, description, allowed-tools, context, agent) + constraint tags (HOW/WHAT/Template/Guardrails)
     - **rule**: frontmatter with paths + actionable instructions (<20 lines)
     - **hook**: hooks.json entry (timeout, matcher, command) + handler script
     - **agent**: frontmatter (name, description, tools, model, maxTurns, memory) + system prompt
     - **mcp**: .mcp.json entry (command, args, env — no hardcoded API keys)
     - **claude-md**: Stack, Commands, Structure, Rules sections (<200 lines)
     - **memory**: MEMORY.md template organized by topic

5. **[HOW]** Validate type-specific constraints:
   - skill: name format, tool least-privilege, guardrails section exists
   - rule: glob patterns valid, instructions actionable (no "consider"), concise
   - hook: timeout ≤5s for PreToolUse, ≤30s for others, matcher not overly broad
   - agent: name lowercase-hyphens, model explicit, tools minimal
   - mcp: command executable, env vars for secrets
   - claude-md: <200 lines, copy-pasteable commands
   - memory: <200 lines, no session-specific content

6. **[HOW]** Write/Edit file to target path

7. **[HOW]** Independent review:
   - Spawn Explore agent to validate the generated/updated file against knowledge base
   - Fix any issues found

## Target Paths

| Type | Path |
|------|------|
| skill | ` + "`.claude/skills/<name>/SKILL.md`" + ` |
| rule | ` + "`.claude/rules/<name>.md`" + ` |
| hook | ` + "`.claude/hooks.json`" + ` (or settings.json hooks section) |
| agent | ` + "`.claude/agents/<name>.md`" + ` |
| mcp | ` + "`.mcp.json`" + ` |
| claude-md | ` + "`CLAUDE.md`" + ` (project root) |
| memory | Auto memory path ` + "`MEMORY.md`" + ` |

## Guardrails

- Do NOT overwrite existing files without asking for approval first
- Do NOT use overly broad tool lists — apply least-privilege
- Do NOT skip the independent review step
- Do NOT hardcode API keys or secrets in any generated file
- Do NOT create files that exceed type-specific line limits
- Preserve the user's voice and style when updating existing files
`,
	},
	{
		Dir: "setup",
		Content: `---
name: setup
description: >
  Project-wide Claude Code setup wizard, or explain any Claude Code feature
  with examples. Scans the whole project and guides multi-file configuration.
  For single-file work, use /alfred:configure instead.
user-invocable: true
argument-hint: "[feature | --wizard]"
allowed-tools: Read, Write, Edit, Glob, Bash, AskUserQuestion, mcp__alfred__knowledge, mcp__alfred__review
context: current
---

The butler welcomes the master and briefs them on the estate.

## Steps

1. **[WHAT]** Determine mode from $ARGUMENTS:
   - If arguments contain a feature name (hooks, skills, rules, agents, MCP, memory, worktrees, teams) → go to Step 2 (brief flow)
   - If arguments contain "--wizard" or no arguments → go to Step 3 (wizard flow)

2. **[HOW]** Brief flow — explain a feature:
   - Call ` + "`knowledge`" + ` with query about the selected feature
   - If multiple results, synthesize the most relevant
   - Output in template format:
     ` + "```" + `
     ## <Feature Name>

     **What**: One sentence explanation.

     **When to use**:
     - Scenario 1
     - Scenario 2

     **Setup** (copy-pasteable):
     ` + "```" + `
     <minimal working example>
     ` + "```" + `

     **Tips**:
     - Practical tip 1
     - Practical tip 2
     ` + "```" + `
   - STOP here

3. **[HOW]** Wizard flow — interactive setup:
   - Call ` + "`review`" + ` with project_path=$CWD to assess current setup
   - Present current state as a status checklist: ` + "`[x] CLAUDE.md`" + `, ` + "`[ ] Hooks`" + `, etc.

4. **[WHAT]** Ask what to configure:
   - Use AskUserQuestion with multiSelect=true:
     - CLAUDE.md
     - Skills
     - Rules
     - Hooks
     - MCP servers
     - Memory
   - Pre-select items that are missing

5. **[HOW]** Auto-detect project stack:
   - go.mod → Go project defaults (go vet, go test, Go rules)
   - package.json → Node project defaults (npm test, ESLint rules)
   - Cargo.toml → Rust project defaults
   - pyproject.toml → Python project defaults
   - Fall back to generic defaults

6. **[HOW]** Generate selected items:
   - For each selected item, follow generation logic with sensible defaults based on detected stack
   - Use streamlined wizard mode — ask fewer questions, prefer smart defaults

7. **[HOW]** Verify setup:
   - Call ` + "`review`" + ` again to check improvement
   - Report before/after score

8. **[Template]** Final output:
   ` + "```" + `
   ## Setup Complete

   Created:
   - CLAUDE.md (N lines)
   - .claude/hooks.json (N hooks)
   - ...

   Setup Score: N/10 (was M/10)

   Next: Try asking Claude Code about your project — alfred's knowledge
   base will help provide better answers.
   ` + "```" + `

## Guardrails

- Do NOT overwrite existing files without asking
- Do NOT create configurations that conflict with each other
- Do NOT ask more than 2 questions per item in wizard mode (wizard should be fast)
- Do NOT skip stack detection — it drives sensible defaults
- Do NOT create items the user didn't select
- Do NOT output more than 20 lines in brief mode unless the user asks for detail
- Do NOT fabricate features in brief mode — only explain what's in the knowledge base
`,
	},
	{
		Dir: "harvest",
		Content: `---
name: harvest
description: >
  Manually refresh the alfred knowledge base. Normally auto-harvest keeps
  docs fresh automatically — use this for forced full crawl or targeted
  page updates.
user-invocable: true
allowed-tools: Bash, mcp__alfred__knowledge
context: current
---

The butler's procurement run — gathering the finest ingredients for the knowledge base.

## Steps

1. **[HOW]** Run the harvest CLI command:
   ` + "```bash" + `
   alfred harvest
   ` + "```" + `
   This crawls all documentation sources (official docs, changelog, engineering blog),
   upserts into the knowledge base, and generates embeddings.
   The command shows a TUI progress display.

2. **[WHAT]** Verify the result:
   - Call ` + "`knowledge`" + ` with query="Claude Code hooks" (limit=1) to confirm docs are fresh
   - Report the harvest result to the user

## Guardrails

- Do NOT use WebFetch or ingest MCP — the CLI handles everything natively
- Do NOT run harvest if VOYAGE_API_KEY is not set (the CLI will error)
`,
	},
	{
		Dir: "brainstorm",
		Content: `---
name: brainstorm
description: |
  発散（ブレスト）: ラフなテーマから観点・選択肢・仮説・質問を増やし、次の意思決定に渡せるMarkdownを作る。
  alfred knowledge を活用してナレッジベースから関連情報を補強する。
  Use when: (1) 何を考えるべきか分からない, (2) アイデアが少ない/思考が固い,
  (3) リスクや論点を洗い出したい, (4) 収束（意思決定）に渡す材料が欲しい（/alfred:refine 用の素材）。
user-invocable: true
argument-hint: "<theme or rough prompt>"
allowed-tools: Read, Glob, Grep, WebSearch, WebFetch, AskUserQuestion, Agent, mcp__alfred__knowledge, mcp__alfred__butler-init
context: current
---

# /alfred:brainstorm

AIと一緒に「発散」を行い、思考の材料（選択肢・観点・仮説・質問）を増やすスキル。
目的は"決めること"ではなく、"増やすこと"。ただし最後に「収束に進める入口」を作る。

## 重要宣言（運用ルール）
- このスキルの役割は **発散**。判断・決定はしない（決めるのは /alfred:refine）。
- 事実が不足している箇所は「仮説」と明記し、**推測で断定しない**。
- 長文化したら要点だけに圧縮して続行する。

## alfred特化ポイント
- Phase 1 で ` + "`knowledge`" + ` ツールを使い、ナレッジベースから関連ドキュメント・ベストプラクティスを検索して発散の材料にする
- Phase 4 出力後に「butler-init でspec化する？」の選択肢を提示する
- 出力結果はDBに永続化可能（butler-init経由）

## Phase 0: 受理 & 最小前提確認（AskUserQuestion 推奨）
以下を最大3問で確認（選択肢つき）:

1) ゴールはどれ？
- a) 方向性を決めたい
- b) 選択肢を増やしたい
- c) リスク/論点を洗い出したい
- d) 問いの立て直しをしたい

2) 制約はある？
- 期限 / 時間 / 予算 / 体制 / 技術縛り / 絶対NG

3) 対象範囲は？
- 個人の意思決定 / チームの合意 / プロダクト / 学習 / キャリア etc

※ユーザーが「お任せ」と言ったら「一般的な前提」で進める。

## Phase 1: 観点の網羅（発散）+ ナレッジ検索
まず ` + "`knowledge`" + ` ツールでテーマに関連するドキュメントを検索し、発散の材料にする。

最低でもこの"観点ブロック"を出す:
- 目的・成功状態（What good looks like）
- 対象ユーザー/状況（誰の何が変わる）
- アプローチの類型（解決策のタイプ）
- トレードオフ軸（速度/品質、短期/長期 等）
- リスク/失敗パターン
- 検証（どう確かめるか）

## Phase 2: アイデア生成（束で）
「保守的/現実的/実験的」の3束で、各3〜7個。
各アイデアは必ずこの形で短く:
- 一言
- 30秒説明
- 効く条件
- 制約との相性
- 最小検証

## Phase 3: 収束に必要な質問を生成
収束（意思決定）で決めるための質問を5〜12個作る。

## Phase 4: 出力（Markdown）
必ずこの構造で出す:

` + "```md" + `
# Brainstorm Output: <テーマ>

## 前提
- ゴール:
- 制約:
- 対象範囲:

## 観点（抜け漏れ防止）
- ...

## アイデア束
### 保守的
- ...
### 現実的
- ...
### 実験的
- ...

## リスク/懸念（想定失敗パターン）
- ...

## 検証のタネ
- テスト案:
- 観測/ログ案:

## 次に答えると収束できる質問（重要順）
1.
2.
3.

## 次の一手（推奨）
- 収束に進むなら：/alfred:refine
- spec化するなら：/alfred:plan
- 探索するなら：Plan Modeで読むべき @file / 調べるべきコマンド候補
` + "```" + `

## 終了条件
- ユーザーが「十分」と言う
- アイデアが"束"で最低10個出た
- 収束に必要な質問が揃った
`,
	},
	{
		Dir: "refine",
		Content: `---
name: refine
description: |
  壁打ち（収束）: 論点を1行に固定し、選択肢を最大3に絞り、評価軸で決め、次のアウトプットを確定してMarkdown化する。
  決定事項は butler-update で自動的にspec保存される。
  Use when: (1) モヤモヤして手が動かない, (2) 候補はあるが決めきれない, (3) 最小スコープを確定したい,
  (4) ブレスト結果やメモを意思決定に落としたい。
user-invocable: true
argument-hint: "<theme or current messy notes>"
allowed-tools: Read, Glob, Grep, WebSearch, WebFetch, AskUserQuestion, Agent, mcp__alfred__knowledge, mcp__alfred__butler-update, mcp__alfred__butler-status
context: current
---

# /alfred:refine（壁打ち）

目的: 前に進むための「合意された決定」と「次のアウトプット」を作る。
方針: Claude Code公式の Explore→Plan→Implement に合わせ、ここは Plan までを強くする。

## 重要宣言（運用ルール）
- このスキルの役割は **収束（意思決定）**。実装はしない。
- このスキルの出力は「次の計画/実装の入力」になる。曖昧さを残さない。
- 事実が不足している箇所は推測で埋めず、質問で確定する。
- 話が発散したら必ず「1行の論点」に戻る。

## alfred特化ポイント
- ` + "`knowledge`" + ` ツールで関連ベストプラクティスを検索して判断材料にする
- Phase 4（決定）後に ` + "`butler-update decisions.md`" + ` で決定を自動記録する
- アクティブなspecがあれば ` + "`butler-status`" + ` で現在の状態を確認してから開始する

## Phase 0: 詰まりタイプ診断（1問）
以下から選んでもらう:
1) 問いが不明
2) 多すぎて選べない
3) 最小化できない
4) 次の一手が曖昧
5) 不安で止まる

## Phase 1: 論点固定（合意まで微修正）
次の1行を作って合意:
- 「私は <状況> において <決めたいこと> を <制約> の中で決めたい」

## Phase 2: 選択肢の棚卸し（最大5→3）
既存案があれば列挙。なければ暫定3案を仮置きしてYes/Noで整える。

## Phase 3: 評価軸（3〜5個）確定 → ラフ採点
よく使う軸: インパクト / 実現容易性 / 失敗コスト / 学び / 継続性 / 依存の少なさ

## Phase 4: 決定（ここが合意点）
- 採用案（1つ） or 2案を順番に試す
- OUT（やらないこと）を必ず3つ
- **アクティブなspecがあれば ` + "`butler-update`" + ` で decisions.md に記録する**

## Phase 5: 検証方法（自己検証の条件を固定）
テスト/期待出力/スクショ比較/コマンド

## Phase 6: 次のアウトプットを1つ確定
例: 1枚図 / 1ページ仕様 / 最小デモ。完了条件を1行で。

## Phase 7: 出力（Markdown）
必ずこの構造:

` + "```md" + `
# Refine Output: <テーマ>

## 1行の論点（合意版）
- ...

## 前提・制約
- ...

## 選択肢（最大3）
1.
2.
3.

## 評価軸とラフ採点（1〜5）
| 軸 | 1 | 2 | 3 | メモ |
|---|---:|---:|---:|---|
| インパクト | | | | |
| 実現容易性 | | | | |
| 失敗コスト | | | | |

## 決定
- 採用案:
- 理由（短く）:
- OUT（やらないこと）:
  - ...
  - ...
  - ...

## 検証
- 実行コマンド/チェック:
- 期待結果:

## 次のアウトプット（これだけやる）
- 成果物:
- 完了条件:
- 参考に見るべき @file / コマンド:
` + "```" + `

## 終了条件
- 1行論点が合意できた
- 最大3案に絞れた
- 次のアウトプットが1つ決まった
`,
	},
	{
		Dir: "plan",
		Content: `---
name: plan
description: >
  Butler Protocol: 対話的にspecを生成する。要件定義→設計→タスク分解を行い、
  .alfred/specs/ に保存。Compact/セッション喪失に強い開発計画を作成する。
  Use when: (1) 新しいタスクを始める, (2) 設計を整理したい, (3) 作業を再開する前に計画を立てたい。
user-invocable: true
argument-hint: "<task-slug> [description]"
allowed-tools: Read, Write, Edit, Glob, Grep, WebSearch, AskUserQuestion, Agent, mcp__alfred__knowledge, mcp__alfred__butler-init, mcp__alfred__butler-update, mcp__alfred__butler-status
context: current
---

# /alfred:plan — Butler Protocol Spec Generator

対話的にspecを生成し、Compact/セッション喪失に強い開発計画を作る。

## Core Principle
**Compactで最も失われるのは「推論過程」「設計判断の理由」「探索の死に筋」「暗黙の合意」。**
これらを明示的にファイルに書き出すことで、どのタイミングでセッションが切れても完璧に復帰できるspecを作る。

## Steps

1. **[WHAT]** Parse $ARGUMENTS:
   - task-slug（必須）: URL-safe identifier
   - description（任意）: 概要
   - 引数がなければ AskUserQuestion で確認

2. **[HOW]** Call ` + "`butler-status`" + ` to check existing state:
   - If active spec exists for this slug → resume mode (skip to Step 7)
   - If no spec → creation mode (continue)

3. **[HOW]** Requirements gathering (対話, 最大3問):
   - What is the goal? (1文で)
   - What does success look like? (計測可能な条件)
   - What is explicitly out of scope?

4. **[HOW]** Design decisions (対話 + knowledge検索):
   - Call ` + "`knowledge`" + ` to search for relevant best practices
   - Discuss architecture approach
   - Record alternatives considered (CRITICAL for compact resilience)

5. **[HOW]** Task breakdown:
   - Break into concrete, checkable tasks
   - Order by dependency

6. **[HOW]** Call ` + "`butler-init`" + ` with gathered information:
   - Creates all 6 files with templates
   - Then call ` + "`butler-update`" + ` for each file to fill in gathered content:
     - requirements.md: replace with full requirements
     - design.md: replace with design decisions
     - tasks.md: replace with task checklist
     - decisions.md: append initial design decisions
     - session.md: replace with current position + next steps

7. **[OUTPUT]** Confirm to user:
   ` + "```" + `
   Butler Protocol initialized for '{task-slug}'.

   Spec files: .alfred/specs/{task-slug}/
   - requirements.md ✓
   - design.md ✓
   - tasks.md ✓
   - decisions.md ✓
   - knowledge.md ✓
   - session.md ✓

   DB synced: {N} documents indexed.

   Compact resilience: Active. Session state will auto-save before compaction.
   Session recovery: Active. Context will auto-restore on session start.

   Ready to implement. Start with the first task in tasks.md.
   ` + "```" + `

## Resume Mode (from Step 2)

If an active spec already exists:
1. Call ` + "`butler-status`" + ` to get current session state
2. Read spec files in recovery order:
   - session.md (where am I?)
   - requirements.md (what am I building?)
   - design.md (how?)
   - tasks.md (what's done/remaining?)
   - decisions.md (why these choices?)
   - knowledge.md (what did I learn?)
3. Present summary: "Resuming task '{slug}'. Last position: {current_position}. Next steps: {next_steps}"
4. Ask: "Continue from here, or update the plan?"

## Guardrails

- Do NOT skip requirements gathering — even for "obvious" tasks
- Do NOT leave decisions.md empty — record at least the initial approach decision
- Do NOT create tasks without success criteria
- ALWAYS record alternatives considered, even if only briefly
- ALWAYS update session.md with current position after plan completion
`,
	},
}

// deprecatedSkillDirs lists skill directories from previous versions that
// should be cleaned up during install/uninstall.
var deprecatedSkillDirs = []string{
	// v0.1-v0.19 era
	"init",
	"alfred-unstuck",
	"alfred-checkpoint",
	"alfred-before-commit",
	"alfred-impact",
	"alfred-review",
	"alfred-estimate",
	"alfred-error-recovery",
	"alfred-test-guidance",
	"alfred-predict",
	// v0.20-v0.22 era
	"alfred-recover",
	"alfred-gate",
	"alfred-analyze",
	"alfred-forecast",
	"alfred-context-recovery",
	"alfred-crawl",
	// v0.23 era (alfred- prefix removed in v0.24)
	"alfred-create-skill",
	"alfred-create-rule",
	"alfred-create-hook",
	"alfred-create-agent",
	"alfred-create-mcp",
	"alfred-create-claude-md",
	"alfred-create-memory",
	"alfred-review",
	"alfred-audit",
	"alfred-learn",
	"alfred-preferences",
	"alfred-update-docs",
	"alfred-update",
	"alfred-setup",
	"alfred-migrate",
	"alfred-explain",
	// v0.24-v0.26 era (renamed to butler-style in v0.27)
	"create-skill",
	"create-rule",
	"create-hook",
	"create-agent",
	"create-mcp",
	"create-claude-md",
	"create-memory",
	"review",
	"audit",
	"learn",
	"preferences",
	"update-docs",
	"update",
	"setup",
	"migrate",
	"explain",
	// v0.27-v0.28 era (consolidated into configure/setup/harvest)
	"inspect",
	"prepare",
	"polish",
	"greetings",
	"brief",
	"memorize",
}

