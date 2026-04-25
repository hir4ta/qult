# ink-dashboard — Requirements

## Overview

qult に **Ink + @inkjs/ui** ベースのリアルタイム進捗監視ダッシュボードを導入する。
別ターミナルで `qult dashboard` を起動し、Claude が別プロセスで作業する間に
spec / wave / detector / test / review の状態を live で観察する。
さらに `qult check --detect` 実行時にも detector ごとの進行を Spinner / ProgressBar / Badge でリッチ表示する。

既存の高頻度コマンド (`qult init/update/check/add-agent/mcp`) の起動コスト・依存量に影響を与えないよう、
Ink を使うコードは独立した bundle entry に分離する。

## Stakeholders / Personas

- **architect (user)**: 別ターミナルで dashboard を眺めながら Claude に作業を任せたい
- **CI / non-TTY 環境**: dashboard は使わない。既存 `check` の plain 出力は維持

## Functional Requirements

### FR-1. `qult dashboard` コマンド
- WHEN ユーザーが `qult dashboard` を実行した THEN システムは Ink ベースの live UI を起動する
- WHILE dashboard が起動している間、`.qult/state/*.json` および `.qult/specs/<active>/waves/*.md` の変更を監視し、画面を即時更新する
- WHEN ユーザーが `Ctrl+C` または `q` キーを押した THEN プロセスは即座に終了し、ターミナルを復元する
- IF active spec が存在しない THEN 「No active spec. Run /qult:spec to start.」を表示し、それでも live で active spec の出現を待ち受ける
- WHERE 標準出力が TTY ではない (CI / pipe) THEN dashboard は plain text フォールバックを 1 度だけ出力して終了する

### FR-2. Dashboard レイアウト
- WHEN dashboard が描画される THEN 画面を 4 領域に分割する:
  - **Header**: qult version / active spec 名 / 経過時間
  - **Wave Progress**: 現在の Wave 番号、タスク完了数 / 総数、ProgressBar、各 Wave の Badge (todo/in-progress/done)
  - **Detector Status**: 5 detector の最新状態 (pass/warn/fail/skipped) を Badge で並べ、pending fixes 件数を表示
  - **Review Stage Scores**: 4 stage (Spec / Quality / Security / Adversarial) を個別 Badge で表示。各 stage の最新スコアと閾値到達状態を視認できる
  - **Recent Events**: dashboard 専用のイベントストリーム (FR-4 参照) から直近 10 件の状態変化を時系列で StatusMessage 表示
- WHILE dashboard が起動中、ターミナル幅・高さの変化を `useStdout` で検知する
- WHEN 利用可能な幅・高さが変わった THEN レイアウトを連続的に再計算し、横並び ↔ 縦積み、Recent Events の表示件数、各セクションの flexBasis を動的に調整する (固定閾値は持たない)
- IF 極端に狭いターミナル (例: 40 桁未満) THEN 重要度の低いセクション (Recent Events 等) を折りたたみ、最小限の Wave Progress と Detector Status のみ表示する

### FR-3. `qult check --detect` 実行中 UI
- WHEN `qult check --detect` が実行された THEN 各 detector の実行を Ink で進捗表示する
- WHILE detector が実行中、その detector を Spinner で表示する
- WHEN detector が完了した THEN Badge (pass/warn/fail/skipped) と所要時間を表示する
- WHEN 全 detector 完了 THEN サマリ (pending fixes 件数、severity 別内訳) を Alert で表示する
- WHERE `--no-tty` フラグまたは非 TTY 環境 THEN 既存の plain 出力にフォールバックする

### FR-4. 状態ファイル監視・イベントストリーム
- WHILE dashboard が起動中、`.qult/state/` 配下の JSON ファイル変更を `fs.watch` で検知する
- WHILE dashboard が起動中、`.qult/specs/` 配下の active spec 切り替え (`current.json` 相当 / archive 移動) を検知する
- WHEN active spec が変更された THEN dashboard は再起動なしで新 spec に自動追従し、Header / Wave Progress / Review を切り替える
- WHEN JSON が atomic rename で更新された THEN ファイルを再読み込みし、UI を更新する
- WHEN 状態変化を検知した THEN dashboard 専用のイベントストリーム (in-memory ring buffer) に「test pass」「review 完了」「wave 完了」「detector 結果更新」等のエントリを push する
- IF JSON のパースに失敗した THEN 直前の状態を保持し、エラーを Alert で 1 行表示する

### FR-5. 依存・配布の隔離
- WHERE Ink/React/@inkjs/ui を使うコード THEN `src/dashboard/` 配下に隔離する
- WHEN tsup でビルドする THEN `qult dashboard` 用の独立 entry (`dist/dashboard.js`) を生成し、ink/react/@inkjs/ui を transitive にバンドルする
- WHERE `package.json` の依存配置 THEN ink / react / @inkjs/ui は `devDependencies` に置き、ビルド時にバンドルされて `dependencies` には増えないこと (qult 既存の「dependencies ゼロ」方針を維持)
- IF ユーザーが `qult dashboard` 以外を起動した THEN Ink 依存はロードされない (CLI entry の動的 import で遅延ロード)

### FR-6. テーマ
- WHERE デフォルトテーマ THEN cyan / magenta / yellow / green を主軸にしたカラフルな配色 (Claude Code 的な視認性の高い色使い)
- 各 Badge / Alert / StatusMessage には variant (success / warning / error / info) ごとの色を統一的に割り当てる
- @inkjs/ui の `extendTheme` でラップし、将来の `.qult/config.json` からの上書きに備える (v1 では config 連携は実装しない、上書き口だけ用意)

## Non-Functional Requirements

### NFR-1. パフォーマンス
- 既存 `qult check` / `qult init` / `qult update` の cold start 時間が Ink 導入後も 100ms 以内の悪化に収まること
- dashboard の再描画レートは 200ms デバウンスで十分 (人間の視認速度)

### NFR-2. 互換性
- Node 20+ で動作 (現状の package.json engines に準拠)
- macOS / Linux ターミナル対応 (Windows は best effort)
- 既存の状態ファイルスキーマを変更しない

### NFR-3. テスト性
- Ink コンポーネントは `ink-testing-library` で snapshot / 出力検証可能であること
- watch ロジックはコンポーネントから分離 (純粋な hook + reducer)

### NFR-4. デザイン品質
- 色・Badge・Alert・ProgressBar・StatusMessage を組み合わせて視覚的に richな見た目
- テーマは @inkjs/ui の `extendTheme` でカスタマイズ可能にしておく (将来の `.qult/config.json` 連携用)

## Out of Scope

- マウス操作 (Ink は基本的に未対応)
- スクロール可能な長尺ログ (直近 N 件のみ)
- リモート監視 / web 版
- dashboard からの操作 (wave 開始 / review 起動など書き込み系) — read-only
- Windows での完全動作保証

## Clarifications (resolved)

1. **テーマカラー**: cyan / magenta / yellow / green を主軸にしたカラフル配色 (FR-6)
2. **Recent Events のソース**: dashboard 専用の in-memory イベントストリーム (FR-4)
3. **Review スコア粒度**: 4 stage 個別 Badge 表示 (FR-2)
4. **`qult check --detect` Ink 化**: 本 spec の v1 で同時実装 (FR-3)
5. **active spec 切り替え**: 自動追従 (FR-4)
6. **依存配置**: `devDependencies` に置き、tsup でランタイムバンドル (FR-5)
7. **レイアウト切り替え閾値**: 固定閾値なし。ターミナル幅・高さに応じて連続的に再計算 (FR-2)
