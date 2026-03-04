# Setup TUI リデザイン Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `claude-alfred setup` の TUI をミニマルモダンに刷新し、README の setup 説明を改善する

**Architecture:** 既存の setup.go の View() を書き換え、spinner コンポーネントを追加。ロジック（Update, runSetup）は変更なし。README のインストール手順を見直し、各コマンドの役割を明確にする。

**Tech Stack:** Go / BubbleTea v2 / Bubbles v2 (progress, spinner) / Lipgloss v2

---

### Task 1: spinner を追加して Init フェーズを改善

**Files:**
- Modify: `setup.go:1-70` (imports, model, constructor)

**Step 1: import に spinner を追加**

```go
import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/bubbles/v2/progress"
	"charm.land/bubbles/v2/spinner"
	"charm.land/lipgloss/v2"

	"github.com/hir4ta/claude-alfred/internal/embedder"
	"github.com/hir4ta/claude-alfred/internal/install"
	"github.com/hir4ta/claude-alfred/internal/store"
)
```

**Step 2: setupModel に spinner フィールドを追加**

```go
type setupModel struct {
	phase     setupPhase
	docsTotal int
	docsDone  int
	embedTot  int
	embedDone int
	startTime time.Time
	err       error
	result    install.SeedResult

	spinner  spinner.Model
	progress progress.Model
	cancel   context.CancelFunc
}
```

**Step 3: newSetupModel で spinner を初期化**

```go
func newSetupModel() setupModel {
	s := spinner.New(spinner.WithSpinner(spinner.Dot))
	s.Style = dimStyle
	p := progress.New(
		progress.WithDefaultBlend(),
		progress.WithWidth(40),
	)
	return setupModel{
		phase:     phaseInit,
		startTime: time.Now(),
		spinner:   s,
		progress:  p,
	}
}
```

**Step 4: Init で spinner.Tick を返す**

```go
func (m setupModel) Init() tea.Cmd {
	return tea.Batch(
		m.spinner.Tick,
		tea.Tick(500*time.Millisecond, func(t time.Time) tea.Msg {
			return tickMsg(t)
		}),
	)
}
```

**Step 5: ビルドして確認**

Run: `cd /Users/user/Projects/claude-alfred && go build -o claude-alfred .`
Expected: ビルド成功

**Step 6: コミット**

```
git add setup.go
git commit -m "refactor: setup TUI に spinner コンポーネント追加"
```

---

### Task 2: Update に spinner メッセージハンドリングを追加

**Files:**
- Modify: `setup.go:78-128` (Update method)

**Step 1: spinner.TickMsg のハンドリングを追加**

Update メソッドの switch に以下を追加:

```go
case spinner.TickMsg:
	if m.phase == phaseInit || m.phase == phaseSeeding {
		sm, cmd := m.spinner.Update(msg)
		m.spinner = sm
		return m, cmd
	}
	return m, nil
```

**Step 2: ビルドして確認**

Run: `cd /Users/user/Projects/claude-alfred && go build -o claude-alfred .`
Expected: ビルド成功

**Step 3: コミット**

```
git add setup.go
git commit -m "refactor: setup TUI の Update に spinner ハンドリング追加"
```

---

### Task 3: View をミニマルモダンに書き換え

**Files:**
- Modify: `setup.go:130-184` (View method)

**Step 1: View メソッドを完全に書き換え**

```go
func (m setupModel) View() tea.View {
	var b strings.Builder

	b.WriteString("\n  " + titleStyle.Render("⚡ alfred setup") + "\n\n")

	// Phase 1: Seeding docs.
	switch {
	case m.phase == phaseInit:
		b.WriteString(fmt.Sprintf("  [1/2] Seeding docs %s\n", m.spinner.View()))
	case m.phase == phaseSeeding:
		b.WriteString(fmt.Sprintf("  [1/2] Seeding docs %s %d/%d\n",
			dimStyle.Render("···"),
			m.docsDone, m.docsTotal))
	default:
		b.WriteString(fmt.Sprintf("  [1/2] Seeding docs %s %d/%d %s\n",
			dimStyle.Render("···"),
			m.docsTotal, m.docsTotal,
			doneStyle.Render("✓")))
	}

	// Phase 2: Embedding.
	switch {
	case m.phase < phaseEmbedding:
		// not started yet
	case m.phase == phaseEmbedding:
		pct := 0
		if m.embedTot > 0 {
			pct = m.embedDone * 100 / m.embedTot
		}
		b.WriteString(fmt.Sprintf("  [2/2] Generating embeddings %s %d/%d\n",
			dimStyle.Render("···"),
			m.embedDone, m.embedTot))
		b.WriteString(fmt.Sprintf("        %s %s\n",
			m.progress.View(),
			dimStyle.Render(fmt.Sprintf("%d%%", pct))))
	default:
		b.WriteString(fmt.Sprintf("  [2/2] Generating embeddings %s %d/%d %s\n",
			dimStyle.Render("···"),
			m.embedTot, m.embedTot,
			doneStyle.Render("✓")))
	}

	// Footer.
	elapsed := time.Since(m.startTime).Round(time.Second)
	b.WriteString("\n")

	if m.phase == phaseDone {
		total := m.result.Applied + m.result.Unchanged
		b.WriteString(fmt.Sprintf("  %s (%s)\n",
			doneStyle.Render("✓ Setup complete"),
			elapsed))
		b.WriteString(fmt.Sprintf("  %d docs, %d embeddings\n\n",
			total, m.result.Embedded))
	} else if m.phase == phaseError {
		b.WriteString(fmt.Sprintf("  %s %v\n\n",
			errStyle.Render("✗ Error:"), m.err))
	} else {
		b.WriteString(fmt.Sprintf("  %s\n",
			dimStyle.Render(fmt.Sprintf("%s elapsed", elapsed))))
	}

	return tea.NewView(b.String())
}
```

**Step 2: ビルドして確認**

Run: `cd /Users/user/Projects/claude-alfred && go build -o claude-alfred .`
Expected: ビルド成功

**Step 3: 手動テスト（VOYAGE_API_KEY が設定済みなら）**

Run: `cd /Users/user/Projects/claude-alfred && ./claude-alfred setup`
Expected: ミニマルモダンな TUI 表示。スピナー → 進捗 → 完了の流れ。

**Step 4: コミット**

```
git add setup.go
git commit -m "refactor: setup TUI をミニマルモダンにリデザイン"
```

---

### Task 4: README のインストール手順を改善

**Files:**
- Modify: `README.md:16-45`

**Step 1: インストールセクションを書き換え**

以下のように各ステップの役割を明確にする:

```markdown
## インストール

### 1. プラグインを追加

Claude Code 内で:

```
/plugin marketplace add hir4ta/claude-alfred
/plugin install alfred@hir4ta/claude-alfred
```

プラグイン（skills, rules, hooks, agents, MCP 設定）が `~/.claude/plugins/cache/` に配置される。

### 2. バイナリをインストール

ターミナルで:

```bash
go install github.com/hir4ta/claude-alfred@latest
```

MCP サーバーと Hook handler のバイナリをコンパイルする。
初回は依存ライブラリのビルドに 30〜60 秒かかる。

### 3. API キーを設定

```bash
export VOYAGE_API_KEY=your-key  # ~/.zshrc 等に追加
```

セマンティック検索に [Voyage AI](https://voyageai.com/) を使用する。

### 4. 知識ベースを初期化

```bash
claude-alfred setup
```

公式ドキュメント（1,400+ 件）を SQLite に取り込み、Voyage AI で embedding を生成する。
TUI で進捗を表示する。

Claude Code を再起動すれば完了。
```

**Step 2: ビルドして確認**

Run: `cd /Users/user/Projects/claude-alfred && go build -o claude-alfred .`
Expected: ビルド成功（README 変更はビルドに影響しない）

**Step 3: コミット**

```
git add README.md
git commit -m "docs: README のインストール手順を改善"
```

---

### Task 5: 最終確認

**Step 1: go vet で静的解析**

Run: `cd /Users/user/Projects/claude-alfred && go vet ./...`
Expected: 問題なし

**Step 2: テスト実行**

Run: `cd /Users/user/Projects/claude-alfred && go test ./...`
Expected: 全テストパス

**Step 3: 最終ビルド**

Run: `cd /Users/user/Projects/claude-alfred && go build -o claude-alfred .`
Expected: ビルド成功
