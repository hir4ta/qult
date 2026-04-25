# Requirements: multi-agent-migration

## Overview

qult は現在 Claude Code 専用プラグイン（`plugin/` 配下、Bun ランタイム必須、`~/.claude/plugins/` 経由配布）として実装されている。この仕様は qult を Claude Code Plugin から Node.js 製 CLI ツールへ移行し、`npx qult init` で任意のプロジェクトにインストールできる形に作り変えることを目的とする。

移行後の qult は、Claude Code・Codex・Cursor・Gemini CLI の 4 種の AI コーディングツールそれぞれに対応した設定ファイルを自動生成し、SDD（Spec-Driven Development）と ハーネスエンジニアリングのワークフローを提供する。各ツールの固有フォーマット（`.claude/commands/*.md`、`.cursor/rules/*.mdc`、`.codex/`、`.gemini/commands/*.toml` など）へ、agent-neutral なテンプレートから変換して配置する Integration Registry パターンを採用する。

主な利用者は、複数の AI コーディングツールを使い分けている個人・チーム開発者である。GitHub spec-kit・OpenSpec に匹敵する採用率を目指す。

本移行は **完全な破壊的変更** として実装する（npm パッケージ名は `qult`）。既存 qult Plugin (v1.x) ユーザー向けの後方互換・移行処理は提供しない。

## User Stories

- As an AI コーディングツールユーザー, I want `npx qult init` を実行するだけで使用中のツール向けの SDD ワークフロー設定を自動生成してほしい, so that ツールを乗り換えても同じ品質ゲートで作業を継続できる。
- As a チームリーダー, I want `npx qult check` でプロジェクトの SDD 状態と Tier 1 detector の結果を確認したい, so that CI に組み込んで品質ゲートを自動化できる。
- As a 開発者, I want `npx qult add-agent <tool>` で後からツール対応を追加したい, so that チームのツール環境が変わっても設定を更新できる。
- As a プロジェクトオーナー, I want 独自テンプレートを `templates/` に追加すれば qult が自動で各ツール向けに変換してほしい, so that 自社固有のワークフロールールをすべてのツールに統一して適用できる。
- As a エアギャップ環境の開発者, I want `npx qult init` が npm パッケージ内にバンドルされたテンプレートだけで完結してほしい, so that init 時にネットワーク接続がなくても利用できる。

## Acceptance Criteria

### CLI インストール・配布

- WHEN ユーザーが `npx qult init` を実行した場合、システムは Node.js 20 以上の環境であれば追加インストールなしでコマンドが動作することを保証しなければならない。
- WHEN `npx qult init` が実行された場合、システムはネットワーク接続なしに（npm パッケージ内バンドルのテンプレートのみで）`.qult/` と各 integration 設定ファイルの生成を完了しなければならない。
- WHEN `npx qult --version` が実行された場合、システムは `package.json` の `version` フィールドと一致するバージョン文字列を標準出力に出力しなければならない。
- WHEN `npx qult --help` が実行された場合、システムは `init`・`update`・`check`・`add-agent` の 4 サブコマンドの使用方法を標準出力に表示しなければならない。
- IF `node --version` が Node.js 20 未満を返す環境でコマンドを実行した場合、システムはエラーメッセージと必要なバージョンを標準エラー出力に表示して終了コード 1 で終了しなければならない。
- WHEN CLI コマンドの出力モードが指定されない場合、システムはデフォルトで人間可読フォーマットで出力しなければならない。
- IF `--json` フラグが指定された場合、システムは構造化された JSON を標準出力に出力しなければならない（CI / スクリプトからのパース用）。

### マルチエージェント対応・Integration Registry

- WHEN `npx qult init` が実行された場合、システムはプロジェクトルートの設定ファイル（`.claude/`・`.cursor/`・`.codex/`・`.gemini/` 等の存在、および `package.json` の `devDependencies`）を検査して使用中の AI ツールを自動検出しなければならない。
- WHEN 自動検出で特定の AI ツールが判定できた場合、システムはそのツールに対応する integration の設定ファイルを所定のディレクトリに生成しなければならない。
- IF 自動検出で AI ツールが判定できず、かつ実行環境が TTY である場合、システムはユーザーに対話的に対象 integration の選択を求めなければならない。
- IF 自動検出で AI ツールが判定できず、かつ実行環境が非 TTY である場合、システムは `claude` integration をフォールバックとして選択しなければならない。
- IF `npx qult init --agent <name>` のようにエージェントを明示指定した場合、システムは自動検出を行わずに指定された integration のみの設定ファイルを生成しなければならない。
- WHEN `npx qult add-agent <tool>` が実行された場合、システムはデフォルトで既存の設定ファイルを上書きせず、衝突があった場合はエラーメッセージを表示して終了コード 1 で終了しなければならない。
- IF `npx qult add-agent <tool> --force` のように `--force` フラグが指定された場合、システムは既存の設定ファイルを上書きしなければならない。
- WHERE `claude` integration が有効な場合、システムは `.claude/commands/` に SDD ワークフロー用コマンドファイル（`.md`）を、`CLAUDE.md` に `@AGENTS.md` の import と qult ルールへの参照を生成し、`.mcp.json` に `qult` MCP server を登録しなければならない。
- WHERE `codex` integration が有効な場合、システムは `.codex/config.toml` の `[mcp_servers]` セクションに `qult` MCP server を登録し、`AGENTS.md` に qult ワークフロー指示を書き込まなければならない。
- WHERE `cursor` integration が有効な場合、システムは `.cursor/rules/` に `.mdc` 形式のルールファイルを生成し、`.cursor/mcp.json`（または `~/.cursor/mcp.json`）に `qult` MCP server を登録し、`AGENTS.md` に参照を書き込まなければならない。
- WHERE `gemini` integration が有効な場合、システムは `.gemini/commands/` に `.toml` 形式のコマンドファイルを生成し、`.gemini/settings.json` の `mcpServers` セクションに `qult` MCP server を登録し、`GEMINI.md` に `@AGENTS.md` の import と qult ルール参照を書き込まなければならない。
- WHEN 複数の integration が有効な場合、システムはすべての有効な integration の設定ファイルを並行して生成し、それぞれのファイルの内容は同一の `AGENTS.md` を共通参照しなければならない。

### テンプレート単一ソース

- WHEN テンプレートファイルが `templates/commands/` に存在する場合、システムは各 integration が定義するフォーマット変換規則に従って対象ツール向けファイルを生成しなければならない。
- WHEN ユーザーが `.qult/config.json` の `templates.dir` にカスタムテンプレートディレクトリを指定した場合、システムは組み込みテンプレートより優先してカスタムテンプレートを使用しなければならない。
- WHEN テンプレートをレンダリングする場合、システムは依存ゼロの自作最小置換器を使用し、`{{VAR}}` 形式の単純文字列置換のみをサポートしなければならない（条件分岐・ループ・フィルタは非対応）。
- IF テンプレートファイルに未定義の変数プレースホルダー（例: `{{UNKNOWN}}`）が含まれる場合、システムはそのテンプレートのレンダリングをスキップしてエラーメッセージを標準エラー出力に表示しなければならない。

### AGENTS.md 標準

- WHEN `npx qult init` が実行された場合、システムは有効な integration の種類によらずプロジェクトルートに `AGENTS.md` を生成しなければならない（全エージェント共通）。
- WHEN `AGENTS.md` が既に存在する場合、システムは既存の内容を保持したうえで qult ワークフローセクションをファイル末尾に追記しなければならない（上書き禁止）。
- WHEN 各 integration の context ファイル（`CLAUDE.md`・`GEMINI.md` 等）が生成される場合、システムはそれらのファイルに `@AGENTS.md` import 行を先頭セクションに含めなければならない。

### `.qult/` state とプロジェクト設定

- WHEN `npx qult check` が実行された場合、システムは `.qult/state/current.json` から `active_spec`・`test_passed_at`・`review_completed_at`・`pending_fixes` を読み込み、それぞれの値を人間が読める形式（または `--json` 指定時は JSON）で標準出力に表示しなければならない。
- WHILE `npx qult check` が実行中の場合、システムは `.qult/state/` ファイルへの書き込みを行ってはならない（読み取り専用）。
- IF `.qult/config.json` が存在する場合、システムは既存の config 値を読み込み、デフォルト値にマージして適用しなければならない。
- WHEN プロジェクト設定が必要な場合、システムは `.qult/config.json` を単一の設定ファイルとして使用し、`integrations` セクション・`templates.dir` 等のすべての設定をここに集約しなければならない（別ファイル `qult.config.json` は使用しない）。

### MCP server（全 integration デフォルト有効）

- WHEN いずれかの integration が有効な場合、システムは当該 integration の MCP 設定ファイル形式に従って `qult` MCP server を登録しなければならない。
- WHEN `qult` MCP server が登録される場合、システムは `npx qult mcp` または `node <package-path>/dist/mcp-server.mjs` のいずれかで起動可能な形式でエントリポイントを指定しなければならない。
- WHEN MCP server がビルドされる場合、システムは Node.js 20+ の `process.stdin` / `process.stdout` ベースの stdio JSON-RPC 実装を使用しなければならない（Bun 固有 API は使用しない）。
- WHEN 任意の integration から state を参照する場合、システムは MCP server を経由したアクセスを推奨経路としなければならない（`.qult/state/*.json` の直接参照を context ファイルに指示してはならない）。

### Tier 1 Detector・`npx qult check`

- WHEN `npx qult check` に `--detect` フラグが付与された場合、システムは security-check・dep-vuln-check・hallucinated-package-check・test-quality-check・export-check の 5 検出器を実行しなければならない。
- WHEN いずれかの検出器が HIGH 以上の severity の問題を 1 件以上報告した場合、システムは終了コード 1 で終了しなければならない。
- WHEN すべての検出器が HIGH 以上の問題をゼロ件報告した場合、システムは終了コード 0 で終了しなければならない。
- IF `semgrep` が未インストールの環境で security-check が実行された場合、システムは semgrep なしで実施可能なパターンマッチングのみを行い、警告メッセージを標準エラー出力に表示して検出処理を継続しなければならない。
- IF ネットワーク接続が不可な環境で dep-vuln-check または hallucinated-package-check（外部 API 必須）が実行された場合、システムは当該検出器を自動スキップして警告メッセージを標準エラー出力に表示し、終了コード 0 を維持しなければならない（他検出器の結果がある場合はそれに従う）。

### `npx qult init` 冪等性

- WHEN `npx qult init` が実行されたプロジェクトに既に同じ CLI で生成された `.qult/` 構造が存在する場合、システムは冪等に動作し（既に正しい状態であれば何も変更せず）、結果を「既に初期化済み」として標準出力に表示しなければならない。
- WHEN `npx qult init` 実行時に既存の integration 設定ファイル（CLI が生成したもの）が存在する場合、システムはユーザーに確認プロンプトを表示し、上書きするかどうかを選択させなければならない（TTY 環境）。
- IF `npx qult init --force` が指定された場合、システムは既存ファイルの存在に関わらず確認プロンプトをスキップして強制上書きしなければならない。
- IF 非 TTY 環境で `--force` なしで実行された場合、システムは既存ファイルの上書きを拒否してエラー終了コード 1 で終了しなければならない。

### `npx qult update`

- WHEN `npx qult update` が実行された場合、システムは現在インストールされている npm パッケージのバージョンを確認し、より新しいバージョンが利用可能な場合はその旨を標準出力に表示しなければならない。
- WHEN `npx qult update` が実行された場合、システムは有効な integration それぞれの設定ファイルを最新のテンプレートで再生成しなければならない（既存 `.qult/specs/` と `.qult/state/` は変更しない）。
- WHEN `npx qult update` が integration 設定ファイルを再生成する場合、システムは `# @generated` マーカーが付与されたセクションのみを上書きし、それ以外のユーザー手動編集行は保持しなければならない（マーカーベース更新戦略）。

### ランタイム移行（Bun → Node.js）

- WHEN `qult` パッケージがビルドされる場合、システムは出力物が `node` コマンドで直接実行可能な ESM バンドルとして生成されなければならない（Bun ランタイムが未インストールでも動作すること）。
- IF 開発環境で `bun` が利用可能な場合、システムは開発用スクリプト（テスト・lint・typecheck）で `bun`・`bunx` を使用することを許容しなければならない。
- WHEN 本番配布物（`dist/`）が生成された場合、システムは Node.js 20 以上の環境のみを前提とし、Bun 固有の API を使用してはならない。

### 拡張性・カスタマイズ

- IF プロジェクトルートの `.qult/config.json` の `integrations` セクションにカスタム integration が記述されている場合、システムはそれを読み込み、組み込み integration リストに追加しなければならない。
- WHEN ユーザーが `.qult/config.json` で `templates.dir` にカスタムディレクトリを指定した場合、システムはそのディレクトリを組み込みテンプレートより優先して使用しなければならない。
- WHEN 未知の integration 名が `--agent` フラグまたは `.qult/config.json` で指定された場合、システムはエラーメッセージに利用可能な integration 名の一覧を含めて終了コード 1 で終了しなければならない。

### エラーハンドリング・堅牢性

- WHEN `npx qult init` が `.qult/` の書き込みに失敗した場合、システムは失敗したパスと原因（パーミッション不足等）を標準エラー出力に表示して終了コード 1 で終了しなければならない。
- IF ファイル生成中にディスクフル等の I/O エラーが発生した場合、システムは部分的に書き込まれたファイルを削除して整合性を保たなければならない（原子的書き込み）。
- WHILE integration 設定ファイルを生成中の場合、システムはプロジェクトルート外のパスへの書き込みを拒否しなければならない（パストラバーサル防止）。

## Out of Scope

- Cursor・Gemini CLI・Codex 向けの reviewer / spec-generator エージェントの移植（Claude Code 専用エージェント機能は Claude integration のみに限定、他ツールは AGENTS.md テキスト指示と MCP tool 経由で代替）
- GitHub Copilot integration（MVP 対象外、将来検討）
- `generic` integration（AGENTS.md のみのフォールバック専用 integration、MVP 対象外。AGENTS.md 自体は全 integration 共通で生成される）
- qult Plugin v1.x との後方互換 API・移行処理（npm パッケージ `qult` は完全な破壊的変更として実装。既存 `~/.claude/rules/qult-*.md`・`~/.claude/plugins/cache/qult/` の検出や uninstall プロモートは行わない）
- GitHub Actions / CI 専用のインテグレーション（`npx qult check` を CI から呼ぶことで代替）
- npm 以外のレジストリ（jsr, Deno, GitHub Packages 等）への同時公開
- Windows 向けのネイティブインストーラー（PowerShell スクリプト等）— `npx` 経由のクロスプラットフォーム対応は含む
- マルチ worktree 並列書き込みの競合解決
- SQLite・グローバル設定ファイルへの State 移行
- リアルタイムの進捗プッシュ通知（WebSocket / SSE 等）
- GUI / Web UI の提供
