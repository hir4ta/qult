# チームメトリクス共有 設計ドキュメント

## 背景

qult は現在、各開発者のローカルマシンにメトリクスを蓄積している。
同じリポジトリで作業するチームメンバーのメトリクスを共有し、プロジェクト単位での品質可視化を実現したい。

## 要件

- 同一リポジトリ内のチームメンバーのメトリクスが見える
- 追加インフラ (サーバー、DB、SaaS) 不要
- 本体のコミットログを汚さない
- conflict が起きない
- `qult` の設計思想 (dependencies ゼロ、fail-open、simplest solution) に合致

## 選定: orphan branch パターン

### リサーチ結果

| アプローチ | インフラ | 履歴保持 | conflict | qult 適合度 |
|---|---|---|---|---|
| webhook → DB (DevLake, Middleware) | サーバー必要 | 完全 | なし | 低 |
| SaaS API (Copilot metrics 方式) | SaaS 必要 | 完全 | なし | 低 |
| main branch 内にメトリクス | 不要 | 完全 | あり | 低 (ノイズ) |
| 別リポジトリ | 不要 | 完全 | なし | 中 (セットアップ面倒) |
| **orphan branch + ユーザー別ディレクトリ** | **不要** | **完全** | **なし** | **最高** |

### 採用理由

- gh-pages パターンの応用。GitHub Pages がドキュメントを orphan branch で管理するのと同じ発想
- main branch と履歴を共有しないため、コミットログが完全に分離
- ユーザー別ディレクトリにより、同じファイルを複数人が編集する状況が発生しない
- force push せず通常 push で履歴を保持

## ブランチ構造

```
main (コード)
qult-metrics (orphan branch、main とは無関係)
```

### qult-metrics ブランチのディレクトリ構造

```
qult-metrics/
├── hirata/
│   ├── metrics/
│   │   └── 2026-03/
│   │       ├── 2026-03-27.json
│   │       └── 2026-03-28.json
│   └── gate-history/
│       └── 2026-03/
│           └── 2026-03-28.json
├── tanaka/
│   ├── metrics/
│   │   └── 2026-03/
│   │       └── 2026-03-28.json
│   └── gate-history/
│       └── 2026-03/
│           └── 2026-03-28.json
└── .qult-meta.json   # ブランチのメタ情報 (作成日、バージョン等)
```

### ユーザー識別

`git config user.name` をディレクトリ名に使用。
スペースや特殊文字は kebab-case に正規化 (例: `Taro Yamada` → `taro-yamada`)。

## コマンド設計

### `qult sync`

ローカルのメトリクスを qult-metrics ブランチに push する。

```bash
qult sync
```

処理フロー:
1. ローカルの `.qult/metrics/` と `.qult/gate-history/` を読む
2. qult-metrics ブランチを worktree として checkout (メインの作業を邪魔しない)
3. `<user>/metrics/` と `<user>/gate-history/` にコピー
4. commit + push
5. worktree を cleanup

実装上の注意:
- worktree を使うことで、main の作業状態に一切影響しない
- push 失敗時は stderr に警告のみ (fail-open)
- リモートに qult-metrics ブランチがなければ自動作成 (orphan)

### `qult doctor --metrics --team`

全チームメンバーのメトリクスを集計して表示する。

```bash
qult doctor --metrics --team
```

処理フロー:
1. qult-metrics ブランチを fetch (pull ではなく fetch のみ)
2. `origin/qult-metrics` から全ユーザーの日次ファイルを読む (git show で直接読める、checkout 不要)
3. ユーザー別 + 集計のサマリーを表示

出力イメージ:
```
--- Team Metrics (328 actions across 3 users, 5 sessions) ---

  By user:
    hirata     142 actions, 3 sessions  (first-pass 82%, 2.1 DENYs/commit)
    tanaka      98 actions, 1 session   (first-pass 75%, 3.4 DENYs/commit)
    suzuki      88 actions, 1 session   (first-pass 90%, 1.2 DENYs/commit)

  Project totals:
    Gate pass rate: 71%
    First-pass clean: 81%
    Review pass rate: 85% (7 reviews)
    DENYs per commit: 2.2

  Gates:
    lint         pass 65%, avg 80ms
    typecheck    pass 95%, avg 620ms
    test         pass 88%, avg 4200ms
```

## セットアップフロー

### 初回 (リポジトリに qult-metrics ブランチがない場合)

```bash
qult sync   # 自動で orphan branch を作成して push
```

初回の `qult sync` が以下を自動実行:
1. `git checkout --orphan qult-metrics` で orphan branch 作成
2. ローカルメトリクスをコピー
3. commit + push
4. main に戻る

### 2人目以降

```bash
qult sync   # リモートの qult-metrics を fetch → 自分のディレクトリだけ更新 → push
```

リモートに既に qult-metrics がある場合:
1. `git fetch origin qult-metrics`
2. worktree で checkout
3. 自分のディレクトリだけ更新
4. commit + push

## 自動化の検討

### SessionEnd hook で自動 sync

```json
{
  "SessionEnd": [{
    "type": "command",
    "command": "qult sync --quiet",
    "timeout": 10000
  }]
}
```

セッション終了時に自動で sync。ただし:
- ネットワーク不通時は silent fail
- push 権限がない場合も silent fail
- opt-in (デフォルトは手動 sync)

### CI/CD 連携

GitHub Actions で定期的に qult-metrics ブランチのデータを集計してサマリーを Issue や Slack に投稿することも可能。これは qult 本体のスコープ外だが、データ構造がシンプル (JSON files) なので外部ツールとの連携は容易。

## conflict 回避の保証

| 状況 | conflict する？ | 理由 |
|---|---|---|
| 2人が同時に sync | しない | 異なるディレクトリを更新 |
| 同じ人が2台から sync | しない | 同じディレクトリだが fast-forward merge |
| orphan branch を force push | しない | force push は使わない |
| main branch への影響 | なし | orphan branch は main と無関係 |

唯一のリスク: 同じユーザーが2台のマシンから同時に sync した場合、fast-forward できない可能性がある。
対策: pull → rebase → push のフロー。rebase 失敗時は `--force-with-lease` (最後の手段)。

## .gitignore の扱い

ローカルの `.qult/metrics/` と `.qult/gate-history/` は引き続き .gitignore に入れる。
これらは main ブランチ上では不要であり、qult-metrics ブランチにのみ存在する。

## プライバシー

メトリクスに含まれる情報:
- アクション種別 (DENY, block, respond 等)
- gate 実行結果 (pass/fail, 実行時間)
- session_id, branch, user
- reason (truncated to 100 chars — ファイルパスの一部が含まれうる)

含まれない情報:
- コードの内容
- プロンプトの内容
- ファイルの中身

リスク評価: ファイルパスの一部が reason に含まれるため、プロジェクト構造が推測可能。
ただし同一リポジトリのチームメンバーはコードにアクセス権があるため、追加のリスクなし。

## 未決事項

1. **retention policy**: 古いメトリクスの自動削除 (例: 90日)。sync 時に古いファイルを削除するか？
2. **ブランチ名**: `qult-metrics` で良いか。他のツールと衝突しないか
3. **large repo 対応**: メトリクスが大量に溜まった場合の git clone 時のオーバーヘッド。`--single-branch` で main だけ clone すれば影響なし
4. **GitHub Actions / CI 連携**: 週次サマリーの自動投稿は scope に含めるか

## 参考

- [gh-pages orphan branch パターン](https://safjan.com/git-checkout-orphan-gh-pages-performance-results/)
- [Apache DevLake - DORA Metrics](https://devlake.apache.org/docs/DORA/)
- [GitHub Copilot usage metrics](https://github.blog/changelog/2026-02-27-copilot-metrics-is-now-generally-available/)
- [Middleware - Open-Source DORA Metrics](https://github.com/middlewarehq/middleware)
