# ink-dashboard — Design

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  src/cli/index.ts (existing, lightweight)                       │
│   ├── init / update / check / add-agent / mcp                   │
│   └── dashboard ─── dynamic import ───┐                         │
└───────────────────────────────────────┼─────────────────────────┘
                                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  src/dashboard/ (new, isolated; only loaded on `qult dashboard`)│
│                                                                 │
│   index.ts ── render(<App/>) via ink                            │
│      │                                                          │
│      ├─ state/                                                  │
│      │   ├─ store.ts          (useReducer-based dashboard state)│
│      │   ├─ watcher.ts        (fs.watch on .qult/state, specs)  │
│      │   ├─ events.ts         (in-memory ring buffer, max 100)  │
│      │   └─ active-spec.ts    (resolves & tracks active spec)   │
│      │                                                          │
│      ├─ hooks/                                                  │
│      │   ├─ useDashboardState.ts                                │
│      │   ├─ useTerminalSize.ts (useStdout + resize listener)    │
│      │   └─ useExitKeys.ts     (q / Ctrl+C)                     │
│      │                                                          │
│      ├─ components/                                             │
│      │   ├─ App.tsx                                             │
│      │   ├─ Header.tsx                                          │
│      │   ├─ WavePanel.tsx                                       │
│      │   ├─ DetectorPanel.tsx                                   │
│      │   ├─ ReviewPanel.tsx                                     │
│      │   ├─ EventLog.tsx                                        │
│      │   └─ EmptyState.tsx     (no active spec / non-TTY)       │
│      │                                                          │
│      ├─ check-ui/                                               │
│      │   └─ DetectRunner.tsx   (FR-3 `qult check --detect` UI)  │
│      │                                                          │
│      └─ theme.ts               (extendTheme: cyan/magenta/...)  │
└─────────────────────────────────────────────────────────────────┘
                  │
                  ▼  reads (read-only)
┌─────────────────────────────────────────────────────────────────┐
│  Existing qult state                                            │
│   .qult/state/*.json     (current, pending-fixes, audit-log…)   │
│   .qult/specs/<name>/    (waves/wave-NN.md, tasks.md)           │
└─────────────────────────────────────────────────────────────────┘
```

## Data Model

### DashboardState (single source of truth, in-memory)

```ts
type DashboardState = {
  qultVersion: string;
  startedAt: number;          // for elapsed time in Header

  activeSpec: ActiveSpec | null;
  waves: WaveSummary[];       // parsed from waves/wave-NN.md
  detectors: DetectorSummary[];
  reviews: ReviewStageSummary; // 4 stages
  events: DashboardEvent[];   // ring buffer (max 100, render last N)
  errors: string[];           // parse failures, etc. (max 5, transient)

  terminal: { columns: number; rows: number };
};

type ActiveSpec = { name: string; phase: 'requirements'|'design'|'tasks'|'implementation'|'archived' };

type WaveSummary = {
  number: number;
  status: 'todo' | 'in-progress' | 'done';
  tasksDone: number;
  tasksTotal: number;
  startedAt?: string;
  completedAt?: string;
};

type DetectorSummary = {
  id: 'security'|'dep-vuln'|'hallucinated-package'|'test-quality'|'export';
  status: 'pass'|'warn'|'fail'|'skipped'|'never-run';
  pendingFixes: number;
  lastRunAt?: number;
};

type ReviewStageSummary = {
  spec:        { score: number|null; threshold: number; passed: boolean|null };
  quality:     { score: number|null; threshold: number; passed: boolean|null };
  security:    { score: number|null; threshold: number; passed: boolean|null };
  adversarial: { score: number|null; threshold: number; passed: boolean|null };
};

type DashboardEvent = {
  id: string;          // uuid or counter
  ts: number;
  kind: 'wave-complete'|'wave-start'|'test-pass'|'review'|'detector'|'spec-switch'|'error';
  variant: 'success'|'warning'|'error'|'info';
  message: string;
};
```

### Reducer actions

```ts
type Action =
  | { type: 'state-file-changed'; file: string; payload: unknown }
  | { type: 'wave-file-changed'; waveNumber: number; payload: WaveSummary }
  | { type: 'active-spec-changed'; spec: ActiveSpec | null }
  | { type: 'terminal-resized'; columns: number; rows: number }
  | { type: 'parse-error'; file: string; error: string }
  | { type: 'tick' };  // for elapsed time
```

## Interfaces

### CLI dispatch (src/cli/index.ts, modified)

```ts
case 'dashboard': {
  const { runDashboard } = await import('../dashboard/index.js');
  await runDashboard();
  return;
}
case 'check': {
  const { runCheck } = await import('../cli/check.js');
  if (argv.detect && process.stdout.isTTY && !argv.noTty) {
    const { runDetectUI } = await import('../dashboard/check-ui.js');
    return runDetectUI();
  }
  return runCheck(argv);
}
```

### Dashboard entry

```ts
// src/dashboard/index.ts
export async function runDashboard(): Promise<void> {
  if (!process.stdout.isTTY) {
    printPlainSnapshot();
    return;
  }
  const { render } = await import('ink');
  const { App } = await import('./components/App.js');
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
}
```

### File watcher contract

```ts
type WatcherEvents = {
  on(event: 'state-change', cb: (file: string, payload: unknown) => void): void;
  on(event: 'wave-change', cb: (waveNumber: number, payload: WaveSummary) => void): void;
  on(event: 'spec-change', cb: (spec: ActiveSpec | null) => void): void;
  on(event: 'parse-error', cb: (file: string, error: string) => void): void;
  close(): void;
};

function startWatcher(qultRoot: string): WatcherEvents;
```

実装方針:
- `fs.watch` を `.qult/state/` と `.qult/specs/` に張る (recursive: macOS は OK、Linux は手動展開)
- atomic rename 対策で 50ms デバウンス後に readFile + JSON.parse
- パース失敗は `parse-error` を emit、直前の state を保持

## Component Layout

```
<App>
  <Header />
  <Box flexDirection={isWide ? 'row' : 'column'}>
    <WavePanel />        // flexBasis adjusts to terminal width
    <DetectorPanel />
    <ReviewPanel />
  </Box>
  <EventLog maxLines={computeMaxLines(rows)} />
</App>
```

### 動的レイアウト戦略 (FR-2: 固定閾値なし)

- `useTerminalSize()` で現在の columns/rows を取得 (resize イベント listener)
- 横 3 列に必要な最小幅 = WavePanel(28) + DetectorPanel(28) + ReviewPanel(28) + gaps = ~90 cols
- それ以上 → 3 列横並び、各 panel `flexGrow: 1`
- 60〜90 cols → WavePanel 単独行 + (Detector|Review) を 2 列
- 60 cols 未満 → 全 panel 縦積み
- EventLog の行数は `Math.max(3, rows - usedRows - 4)` で算出 (極小なら折りたたみ)
- **境界値の hysteresis**: ±2 cols 以内では切り替えない (チラつき防止)

## Theme

```ts
// src/dashboard/theme.ts
import { extendTheme, defaultTheme } from '@inkjs/ui';

export const qultTheme = extendTheme(defaultTheme, {
  components: {
    Badge: { styles: {
      success: () => ({ color: 'green' }),
      warning: () => ({ color: 'yellow' }),
      error:   () => ({ color: 'magenta' }),
      info:    () => ({ color: 'cyan' }),
    }},
    StatusMessage: { /* same color map */ },
    Alert:         { /* same color map, plus border */ },
    ProgressBar:   { styles: { completed: () => ({ color: 'cyan' }),
                                 remaining: () => ({ color: 'gray' }) }},
    Spinner:       { styles: { container: () => ({ color: 'magenta' }) }},
  },
});
```

主軸色:
- **cyan**: 進行中 / 主要進捗
- **magenta**: アクセント (Spinner, error 系のアクセント)
- **green**: 成功 / pass
- **yellow**: 警告 / warn
- **red** は使わず error は magenta + Alert variant=error の枠線で訴求

## Build Configuration

### tsup.config.ts (modify)

```ts
export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    'mcp-server': 'src/mcp/server.ts',
    dashboard: 'src/dashboard/index.ts', // NEW
  },
  format: ['esm'],
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' }, // only for cli
  // dashboard entry には banner 不要 (CLI から動的 import)
  external: [],          // ink/react/@inkjs/ui は bundle に含める
  splitting: false,
  noExternal: ['ink', 'react', '@inkjs/ui'],
});
```

実装ノート: cli entry のみ shebang を付ける。tsup の `banner` は entry 別の指定が必要なので、必要なら 2 つの defineConfig を export する。

### package.json

```json
{
  "devDependencies": {
    "ink": "^5.x",
    "react": "^18.x",
    "@inkjs/ui": "^2.x",
    "@types/react": "^18.x",
    "ink-testing-library": "^4.x"
  },
  "dependencies": {} // 維持
}
```

## Key Algorithms

### 1. 動的レイアウト計算 (純粋関数 → テスト容易)

```ts
function computeLayout(cols: number, rows: number): Layout {
  const tier =
    cols >= 90 ? 'wide' :
    cols >= 60 ? 'medium' :
                 'narrow';
  const eventLogLines = Math.max(3, rows - (tier === 'wide' ? 12 : 18));
  return { tier, eventLogLines };
}
```

### 2. アクティブ spec 解決

`.qult/specs/` を `readdir` し、`archive/` を除く最初のディレクトリを active と扱う (qult の現行ロジック踏襲)。
`fs.watch('.qult/specs/', { recursive: true })` で変更検知 → spec ディレクトリ集合の差分から `spec-change` を emit。

### 3. ring buffer event stream

```ts
class EventStream {
  private buf: DashboardEvent[] = [];
  push(e: Omit<DashboardEvent,'id'|'ts'>) {
    this.buf.push({ ...e, id: String(++this.seq), ts: Date.now() });
    if (this.buf.length > 100) this.buf.shift();
  }
  recent(n: number) { return this.buf.slice(-n); }
}
```

watcher が state ファイルの diff を検出した際に、変化の種類 (test pass / wave complete / detector status change) を判定して event を push する。差分は「直前のスナップショットを保持しておき、新値と比較」。

## Dependencies & Risks

### 採用ライブラリ

| パッケージ | 用途 | 備考 |
|---|---|---|
| ink | React renderer | 現行 v5、Node 18+ |
| @inkjs/ui | 高レベル部品 | Spinner / ProgressBar / Badge / StatusMessage / Alert / OrderedList 使用 |
| react | Ink の peer dep | バンドル済み |
| ink-testing-library | コンポーネントテスト | dev-only |

### 設計上のリスク

| リスク | 影響 | 緩和策 |
|---|---|---|
| ink/react を bundle するとサイズ増 (~数 MB) | dashboard.js のみ。CLI entry には影響しない | 動的 import で遅延 |
| `fs.watch` の Linux 非 recursive 問題 | sub-dir の検知漏れ | `.qult/state/`, `.qult/specs/` 配下を手動で展開して watch |
| 標準出力に他のログが混ざるとちらつく | 通常運用では無いが、子プロセス起動時に注意 | dashboard 中は console.log 禁止、watcher のエラーは Alert に集約 |
| Windows ターミナルでの色ずれ | 限定的 | Out of Scope (NFR-2) |
| テーマ拡張で型エラー | @inkjs/ui の theme 型が緩い | 必要に応じ `as const` / unknown キャスト |

## Alternatives Considered

| 案 | 採用しなかった理由 |
|---|---|
| **A. blessed / blessed-contrib** | TUI として強力だが React モデルではなく学習コスト高、活発度に懸念 |
| **B. listr2 / ora で代替** | プログレス表示はできるが live ダッシュボードとしての構成自由度が低く、レイアウト不可 |
| **C. tui-rs / textual 等他言語** | qult は TS/Node 統合の前提を崩したくない |
| **D. dependencies に普通に追加** | qult の「dependencies ゼロ」原則を破る。ユーザー要望どおり devDeps + bundle で吸収 |
| **E. dashboard を独立 npm package に分離** | v1 オーバーエンジニアリング。1 リポジトリで完結させる |

## Out of Scope (再確認)

- マウス操作、リモート監視、書き込み系操作、Windows 完全対応 (requirements.md と一致)

## Wave Plan (tasks.md でブレークダウン)

**Wave 1 — 基盤 / 依存追加 / 動的 import スケルトン**
- devDeps に ink/react/@inkjs/ui/ink-testing-library 追加
- tsup に dashboard entry 追加、CLI に dispatch 追加 (中身は "Hello qult" のみ)
- ビルドが通り、`qult dashboard` で空 UI が出ることを確認

**Wave 2 — 状態取得・watcher・store**
- `src/dashboard/state/` の watcher / events / active-spec / store
- 純粋関数 (computeLayout, EventStream, diff 検出) の単体テスト
- まだ UI には繋がない

**Wave 3 — UI コンポーネント (read-only)**
- Header / WavePanel / DetectorPanel / ReviewPanel / EventLog / EmptyState
- App でレイアウト統合、theme.ts 適用
- ink-testing-library で snapshot

**Wave 4 — 動的レイアウト & 仕上げ**
- useTerminalSize / hysteresis / EventLog 可変行数
- exit keys (q / Ctrl+C)、非 TTY フォールバック
- e2e: 実 `.qult/state/` を編集して画面更新が反映するテスト

**Wave 5 — `qult check --detect` Ink 化 (FR-3)**
- DetectRunner コンポーネント
- detector 逐次実行と Spinner / Badge 連動
- `--no-tty` フラグでフォールバック

各 Wave は独立してビルド・テスト通過させ、`[wave-NN]` プレフィックスで commit。
