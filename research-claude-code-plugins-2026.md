# Claude Code Plugin System Research (2026-03-26)

Claude Code Plugin の仕様・制約・既知バグの調査結果。

## 1. Plugin ディレクトリ構造

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json           # マニフェスト (必須: "name" のみ)
├── skills/                   # SKILL.md per folder
├── commands/                 # レガシースラッシュコマンド (Markdown)
├── agents/                   # サブエージェント定義 (Markdown + frontmatter)
├── hooks/
│   └── hooks.json            # Hook 設定
├── output-styles/            # レスポンススタイル
├── scripts/                  # Hook/ユーティリティスクリプト
├── settings.json             # デフォルト設定 (現在 "agent" キーのみ)
├── .mcp.json                 # MCP サーバー定義
└── .lsp.json                 # LSP サーバー設定
```

**重要**: `.claude-plugin/` には `plugin.json` のみ。他は全てプラグインルート直下。

## 2. Plugin でできること

### Skills & Commands
- `/plugin-name:skill-name` でネームスペース付きスラッシュコマンド
- タスクコンテキストに基づく自動起動
- `$ARGUMENTS` で動的入力
- SKILL.md と同階層にスクリプト・参考ドキュメント配置可能

### Agents
- frontmatter: `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, `isolation` (worktree)
- `/agents` インターフェースに表示
- Claude による自動起動可能

### Hooks (全24イベント)
| Event | ブロック可? | 用途 |
|---|---|---|
| SessionStart | No | 初期コンテキスト注入 |
| UserPromptSubmit | Yes | プロンプト前処理 |
| PreToolUse | Yes (allow/deny/ask) | ツール実行前ゲート |
| PostToolUse | Yes (feedback) | ツール実行後フィードバック |
| PostToolUseFailure | No | ツール失敗時 |
| PermissionRequest | Yes | 許可ダイアログ |
| Stop | Yes (force continue) | 停止前チェック |
| StopFailure | No | API エラー |
| PreCompact | No | コンパクション前保存 |
| PostCompact | No | コンパクション後 |
| SubagentStart | No | サブエージェント起動 |
| SubagentStop | Yes | サブエージェント終了 |
| Notification | No | 通知 |
| InstructionsLoaded | No | CLAUDE.md/rules ロード |
| ConfigChange | Yes | 設定変更 |
| CwdChanged | No | ディレクトリ変更 |
| FileChanged | No | ファイル変更 |
| WorktreeCreate | Yes | Git worktree 作成 |
| WorktreeRemove | No | worktree 削除 |
| TeammateIdle | Yes | チームメンバーidle |
| TaskCompleted | Yes | タスク完了 |
| SessionEnd | No | セッション終了 |
| Elicitation | Yes | MCP ユーザー入力要求 |
| ElicitationResult | Yes | ユーザー応答 |

### 4つのハンドラータイプ
1. **command**: シェルコマンド (stdin JSON, デフォルト600sタイムアウト)
2. **http**: POST (30s)
3. **prompt**: 単発LLM呼び出し (Haiku, 30s)
4. **agent**: マルチターンサブエージェント (60s, 50ツールターン)

### Exit コードの意味
- **Exit 0**: 通過。stdout を JSON として解析
- **Exit 2**: ブロック。stderr を表示。stdout JSON は無視
- **その他**: 非ブロッキングエラー。verbose モードでのみ stderr 表示

### MCP サーバー
- `.mcp.json` でバンドル可能
- プラグイン有効時に自動起動
- `${CLAUDE_PLUGIN_ROOT}` パス変数使用可
- `userConfig` で API キー等をインストール時にプロンプト

### LSP サーバー
- `.lsp.json` で設定
- リアルタイム診断、go-to-definition 等

### User Configuration
- `plugin.json` の `userConfig` でインストール時に値をプロンプト
- `${user_config.KEY}` で MCP/LSP/hook 設定内参照
- 機密値はシステムキーチェーンに保存
- `CLAUDE_PLUGIN_OPTION_<KEY>` 環境変数として export

### Channels
- メッセージチャネル宣言 (Telegram/Slack/Discord スタイル)
- plugin MCP サーバーにバインド

## 3. Plugin でできないこと

| 制約 | 詳細 |
|---|---|
| Agent にhooks/mcpServers/permissionMode定義不可 | セキュリティ制限 |
| カスタム CLI コマンド追加不可 | `claude` CLI にサブコマンド追加はできない |
| プラグインディレクトリ外のファイル参照不可 | キャッシュ隔離 (symlink は許可) |
| settings.json は "agent" キーのみ | 任意の設定オーバーライド不可 |

## 4. 既知のバグ (2026-03時点)

### OPEN: Issue #16538 — SessionStart additionalContext が Plugin hooks で動かない
- Plugin の hooks.json で定義した SessionStart hook は実行されるが、additionalContext が Claude に届かない
- Claude は "SessionStart:Callback hook success: Success" しか見えない
- **ワークアラウンド**: `~/.claude/settings.json` に直接定義する

### OPEN: Issue #10412 — Stop hooks with exit 2 が Plugin で動かない
- Plugin 経由の Stop hook で exit 2 を返してもフィードバックとして機能しない
- **ワークアラウンド**: settings.json に直接定義

### CLOSED (修正済み)
- Issue #37210: PreToolUse `permissionDecision: "deny"` が Edit で無視されていた → 修正済み
- v2.1.81: SessionStart hooks がレジューム時に2回発火 → 修正済み
- v2.1.83: 削除されたプラグインの hooks がプロンプト送信をブロック → 修正済み
- v2.1.84: アンインストール済みプラグインの hooks が発火し続ける → 修正済み

## 5. Plugin vs settings.json Hooks

| 観点 | Plugin hooks | settings.json hooks |
|---|---|---|
| 共有 | マーケットプレイスで配布可 | 手動コピー |
| ネームスペース | `[Plugin]` 表示 | `[User]/[Project]/[Local]` |
| SessionStart additionalContext | **バグで動かない** (#16538) | 動作する |
| Stop exit 2 | **バグで動かない** (#10412) | 動作する |
| 優先度 | settings.json が優先 | 高優先 |

## 6. インストールと配布

### ローカル開発
```bash
claude --plugin-dir ./my-plugin
```

### マーケットプレイス配布
- `/plugin install name@marketplace`
- GitHub リポ、Git URL、ローカルパス、リモート URL
- 公式マーケットプレイス: `claude-plugins-official` (自動利用可能)
- インストールスコープ: user (デフォルト) / project / local / managed
- 自動アップデート対応

### セキュリティ
- `~/.claude/plugins/cache/` にコピー (in-place 使用ではない)
- プラグインデータ: `~/.claude/plugins/data/{id}/`

## 7. Plan Mode の仕組み

### 内部メカニズム
- Plan mode はプロンプトベースのワークフロー（ツールレベルの強制なし）
- Shift+Tab 2回で有効化
- Claude は「Plan mode is active. Edit禁止」というシステム指示を受ける
- Edit/Write は技術的に実行可能（Issue #19874）
- ExitPlanMode ツールで Plan 完了を通知 → ユーザー承認ダイアログ

### Hook との統合
- UserPromptSubmit: `permission_mode === "plan"` で検出可能
- PermissionRequest: `ExitPlanMode` matcher で Plan 完了時に介入可能
- Plan ファイルを読んで構造検証 → deny で差し戻し可能

### 制約
- Plan テンプレート遵守率は未測定（誰も計測していない）
- 「Phase 間」のフック地点は存在しない
- Phase は Claude の出力概念であり、Hook lifecycle の概念ではない

## 8. qult にとっての影響

### Plugin として実装すべきもの
- Skills (/qult:review 等)
- Agents (reviewer)
- Hooks (PostToolUse, PreToolUse, UserPromptSubmit, PreCompact)
- MCP サーバー（将来的に必要になった場合）

### settings.json に書くべきもの (Plugin バグ回避)
- SessionStart hook (#16538)
- Stop hook (#10412)

### ハイブリッドアプローチ
`qult init` コマンドで:
1. Plugin をインストール (skills, agents, PostToolUse/PreToolUse/UserPromptSubmit hooks)
2. settings.json に SessionStart / Stop hooks を書き込み
3. プロジェクトローカル設定 (.qult/) を作成

## Sources

- [Create plugins - Claude Code Docs](https://code.claude.com/docs/en/plugins)
- [Plugins reference - Claude Code Docs](https://code.claude.com/docs/en/plugins-reference)
- [Hooks reference - Claude Code Docs](https://code.claude.com/docs/en/hooks)
- [Hooks guide - Claude Code Docs](https://code.claude.com/docs/en/hooks-guide)
- [Discover and install plugins - Claude Code Docs](https://code.claude.com/docs/en/discover-plugins)
- [Claude Code Plugins README (GitHub)](https://github.com/anthropics/claude-code/blob/main/plugins/README.md)
- [Official Plugins Marketplace](https://github.com/anthropics/claude-plugins-official)
- [Issue #16538](https://github.com/anthropics/claude-code/issues/16538)
- [Issue #10412](https://github.com/anthropics/claude-code/issues/10412)
- [Issue #37210](https://github.com/anthropics/claude-code/issues/37210)
- [Issue #19874](https://github.com/anthropics/claude-code/issues/19874)
