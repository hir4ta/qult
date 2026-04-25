# ink-dashboard — Tasks

各 Wave は独立して: ① ビルド・テスト通過 → ② `[wave-NN]` プレフィックスで commit → ③ `/qult:wave-complete` で次へ。

---

## Wave 1 — 基盤 / 依存追加 / dashboard スケルトン

**Goal**: `qult dashboard` が起動して "Hello qult" が ink で表示される。既存 CLI コマンドへの影響ゼロ。

**Verify**:
- `bun run typecheck && bun run lint && bun run build` 成功
- `node dist/cli.js dashboard` で ink 画面が立ち上がり、`q` または `Ctrl+C` で終了する
- `node dist/cli.js check` の cold start が 100ms 以内の悪化に収まる (簡易計測)
- `bun test` 全 pass (新規追加なし)

**Tasks**:
- [x] 1.1 `package.json` の `devDependencies` に `ink`, `react`, `@types/react`, `@inkjs/ui`, `ink-testing-library` を追加 (`bun add -d ...`)
- [x] 1.2 `tsup.config.ts` に dashboard entry を追加。cli entry のみ shebang banner を残し、dashboard には付けない (entry 別 config が必要なら 2 つに分ける)
- [x] 1.3 `tsup.config.ts` の `noExternal` に `ink`, `react`, `@inkjs/ui` を追加してバンドル
- [x] 1.4 `src/dashboard/index.ts` を作成: `runDashboard()` を export、TTY チェック + 動的 import で `ink.render(<App/>)`
- [x] 1.5 `src/dashboard/components/App.tsx` を作成: 仮の `<Box><Text>Hello qult dashboard (press q to exit)</Text></Box>`
- [x] 1.6 `src/dashboard/hooks/useExitKeys.ts` を作成: `useInput` で `q` または `Ctrl+C` 検知 → `useApp().exit()`
- [x] 1.7 `src/cli/index.ts` (既存) に `dashboard` サブコマンドを追加: 動的 import で `runDashboard()` 呼び出し
- [x] 1.8 非 TTY 時 (`process.stdout.isTTY` false) は plain text を 1 行出力して即終了
- [x] 1.9 `src/__tests__/dashboard/smoke.test.ts`: `ink-testing-library` で App をレンダリング、"Hello qult" を含むことを検証
- [x] 1.10 README または docs に `qult dashboard` の暫定説明を 3 行追加

**Consumers**: なし (新機能)

---

## Wave 2 — 状態取得・watcher・store・event stream

**Goal**: ink を使わない純粋なロジック層を完成させる。`.qult/state/` および `.qult/specs/` の変更を検知し、`DashboardState` が reducer 経由で正しく更新される。UI には未接続。

**Verify**:
- 純粋関数 (`computeLayout`, `EventStream`, diff 検出, active spec 解決) の単体テストが 90% 以上カバー
- 一時ディレクトリで `.qult/state/*.json` と `waves/wave-NN.md` を変更 → watcher が正しい event を emit する e2e テスト

**Tasks**:
- [x] 2.1 `src/dashboard/state/store.ts`: `DashboardState` 型と `reducer(state, action)` を実装 (design.md の型定義に従う)
- [x] 2.2 `src/dashboard/state/events.ts`: `EventStream` クラス (ring buffer max 100、push/recent)
- [x] 2.3 `src/dashboard/state/active-spec.ts`: `.qult/specs/` を readdir、`archive/` を除外して active spec 名と phase を返す。phase 判定は requirements/design/tasks の存在から推定
- [x] 2.4 `src/dashboard/state/watcher.ts`: `fs.watch` で `.qult/state/`, `.qult/specs/` を監視 (Linux 対応で recursive 不可なら手動展開)
- [x] 2.5 watcher: 50ms デバウンス → readFile + JSON.parse → 直前スナップショットと diff → 種類判定して event push、reducer に dispatch
- [x] 2.6 watcher: パース失敗時は `parse-error` action を emit、直前 state は保持
- [x] 2.7 watcher: active spec ディレクトリ集合の差分から `spec-change` action を emit (FR-4 自動追従)
- [x] 2.8 `computeLayout(cols, rows)` を `src/dashboard/state/layout.ts` に純粋関数として実装 (tier: wide/medium/narrow + eventLogLines、hysteresis は呼び出し側で管理)
- [x] 2.9 単体テスト: `__tests__/dashboard/store.test.ts`, `events.test.ts`, `layout.test.ts`, `active-spec.test.ts`
- [x] 2.10 e2e テスト: `__tests__/dashboard/watcher.e2e.test.ts` で tmp dir に状態ファイルを作成→更新→delete し、event 列が期待通りであることを検証

**Consumers**: Wave 3 (App.tsx で `useReducer` + watcher 統合)

---

## Wave 3 — UI コンポーネント (read-only)

**Goal**: 全 panel が実装され、固定サイズで横 3 列に並んだ状態で正しく描画される。テーマ適用済み。

**Verify**:
- ink-testing-library の snapshot テストが各コンポーネントで pass
- 実 `.qult/` を持つ qult 自身でビルド→`qult dashboard` 起動し、archive 済み spec の状態が一画面に表示される
- 色・Badge・ProgressBar・Spinner・StatusMessage が design.md のテーマ通りに出ている (目視)

**Tasks**:
- [x] 3.1 `src/dashboard/theme.ts`: `extendTheme` で qult テーマ定義 (cyan/magenta/yellow/green/gray)
- [x] 3.2 `src/dashboard/components/Header.tsx`: qult version + active spec 名 + 経過時間 + Badge (phase) を 1 行で表示
- [x] 3.3 `src/dashboard/components/WavePanel.tsx`: 現 Wave の ProgressBar + 全 Wave の OrderedList (各行 Badge: todo/in-progress/done)
- [x] 3.4 `src/dashboard/components/DetectorPanel.tsx`: 5 detector の Badge グリッド + pending fixes 件数を Alert で
- [x] 3.5 `src/dashboard/components/ReviewPanel.tsx`: 4 stage (Spec/Quality/Security/Adversarial) を個別 Badge + スコア/閾値表示
- [x] 3.6 `src/dashboard/components/EventLog.tsx`: `events.recent(maxLines)` を StatusMessage で時系列表示 (variant 別色)
- [x] 3.7 `src/dashboard/components/EmptyState.tsx`: active spec なし時 (Spinner + 待機メッセージ) と非 TTY 時 (plain text) の両用途
- [x] 3.8 `src/dashboard/components/App.tsx`: `useReducer` + watcher を統合、固定 horizontal layout で全 panel を配置
- [x] 3.9 `src/dashboard/hooks/useDashboardState.ts`: store + watcher のライフサイクル管理 hook (mount で start、unmount で close)
- [x] 3.10 各コンポーネントの snapshot テスト (`__tests__/dashboard/components/*.test.tsx`)
- [x] 3.11 自プロジェクトで実機確認: archive spec の状態が実際に出るか目視

**Consumers**: Wave 4 (App.tsx の layout 切り替えロジック追加)

---

## Wave 4 — 動的レイアウト・終了・仕上げ

**Goal**: ターミナル幅・高さ変化に追従して綺麗にレイアウトが組み変わる。終了処理・非 TTY フォールバック・エラー表示が完成。

**Verify**:
- ターミナルを 40 / 60 / 90 / 150 桁で起動し、それぞれ narrow / medium / wide tier に切り替わる
- リサイズ中チラつきがない (hysteresis 効いている)
- `q` / `Ctrl+C` で即終了、ターミナル復元
- 非 TTY (`qult dashboard | cat`) で plain snapshot が 1 度だけ出る
- watcher が壊れた JSON を読んだ際に Alert が出るが、UI は維持される

**Tasks**:
- [ ] 4.1 `src/dashboard/hooks/useTerminalSize.ts`: `useStdout` + resize listener、debounce 100ms
- [ ] 4.2 hysteresis: `±2 cols` 以内では tier を切り替えないラッパ実装
- [ ] 4.3 `App.tsx` を `tier` に応じて `flexDirection` / `flexBasis` / EventLog `maxLines` を切り替え
- [ ] 4.4 narrow tier では Recent Events を折りたたみ、tab/key で展開できるようにする (もしくは 3 行のみ)
- [ ] 4.5 `printPlainSnapshot()` を実装し、非 TTY 時の出力を整える (active spec / wave / detectors / reviews を 1 画面分)
- [ ] 4.6 watcher のエラーを `errors[]` に push、Alert で 1 行表示するコンポーネント `<ErrorBanner>`
- [ ] 4.7 1 秒 tick で経過時間更新 (`setInterval` を hook 化、unmount で clear)
- [ ] 4.8 e2e テスト: 仮想 TTY でリサイズイベントを発火 → tier 切り替えが反映するか
- [ ] 4.9 cold start ベンチ: `qult check` を Wave 0 (現状) と Wave 4 後で比較し、悪化が 100ms 以内であることを記録

**Consumers**: Wave 5

---

## Wave 5 — `qult check --detect` Ink 化

**Goal**: `qult check --detect` 実行中、各 detector の進行が Spinner / Badge / ProgressBar で視覚化される。`--no-tty` で従来出力にフォールバック。

**Verify**:
- TTY で `qult check --detect` を実行 → Spinner が回って各 detector 完了時に Badge に変わる
- 完了後に Alert でサマリ (severity 別 pending fixes 件数) が出る
- `qult check --detect --no-tty` または非 TTY で従来の plain 出力が変わらない
- `bun test` で `__tests__/dashboard/check-ui.test.tsx` が pass

**Tasks**:
- [ ] 5.1 `src/dashboard/check-ui/DetectRunner.tsx`: detector 一覧 + 各行に Spinner/Badge を表示するコンポーネント
- [ ] 5.2 `src/dashboard/check-ui/index.ts`: `runDetectUI()` を export、内部で 5 detector を逐次実行 + state を React に流す
- [ ] 5.3 全体 ProgressBar (完了 detector 数 / 全 detector 数) を上部に表示
- [ ] 5.4 完了時 Alert: severity (high/medium/low) 別の pending fixes を集計表示
- [ ] 5.5 `src/cli/check.ts` (既存) に `--no-tty` フラグ追加。CLI dispatch で TTY && !noTty なら `runDetectUI`、それ以外は従来パス
- [ ] 5.6 既存 detector 関数のシグネチャ変更を最小化。必要なら `onProgress` コールバックを optional 引数で追加 (consumer 互換維持)
- [ ] 5.7 snapshot テスト: detector が pass/warn/fail/skipped 各状態のとき UI が期待通り
- [ ] 5.8 統合テスト: 実 detector を 1 個だけ実行 (security-check の固定入力) して run-to-completion を検証

**Consumers**: 既存 `src/cli/check.ts` (フラグ追加と分岐)、既存 detector (optional `onProgress` 追加)

---

## Cross-Wave 留意事項

- 各 Wave で `bun run typecheck && bun run lint && bun run build && bun test` を必ず通す
- `[wave-NN]` プレフィックスで commit
- spec 全完了時 (Wave 5 done) に `/qult:review` で 4-stage 独立レビュー → archive へ移動
- ink/react は ESM のみ、tsup `format: ['esm']` を維持
- React JSX は `tsconfig.json` の `jsx: "react-jsx"` で。既存 tsconfig 確認・必要なら追加
