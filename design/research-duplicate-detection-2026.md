# AI コード重複検出 — リサーチレポート (2026-03)

## 問題定義

AI コーディングエージェントは「追加するが再構成しない」。

| 指標 | 2021 | 2024 | 変化 |
|---|---|---|---|
| コード重複率 | 8.3% | 12.3% | +48% (4x growth rate) |
| リファクタリング率 | 25% | <10% | -60% |
| Moved lines (コード再利用) | 高い | 継続的低下 | decline |
| 2週間以内再修正率 | 3.1% | 5.7% | +84% |

Source: GitClear 2025 Report (211M changed lines, Google/Microsoft/Meta repos)

### AI エージェントの重複行動パターン (arxiv:2511.04824)

- AI の重複対応動機: わずか **1.1%** (人間は 13.7%)
- AI の再利用/リパーパス動機: **4.6%** (人間は 12.9%)
- AI は「コードジャニター」(変数リネーム等の低レベル) — 人間は「ソフトウェアアーキテクト」(構造改善)
- AI の高レベルリファクタリング: 43.0% vs 人間 54.9%

**結論**: AI は既存コードを検索・再利用する能力が欠如している。ハーネス側で補完が必要。

---

## 検出アプローチの分類

### Type 1: Exact Clone (完全一致)

テキストレベルの完全一致。空白・コメント以外が同一。

| ツール | 言語 | アルゴリズム | 速度 | 備考 |
|---|---|---|---|---|
| **PMD CPD** | 20+言語 (TS対応) | Rabin-Karp token-based | 数百万行/秒 | CLI + Maven 統合 |
| **Simian** | Java, C++, C# 等 | 行ベース比較 | 数百万行/秒 | 設定可能 (空白/大文字) |
| **jscpd** | 150+言語 | Rabin-Karp | ~1400ms/100ファイル | **Node.js API あり** |

### Type 2: Renamed Clone (リネーム済み)

変数名・関数名が異なるが構造は同一。

| ツール | アプローチ | 速度 | 備考 |
|---|---|---|---|
| **jscpd** | Token-based | 高速 | minTokens/minLines で調整 |
| **ast-grep** | Tree-sitter AST パターン | **数万ファイル/秒** (Rust) | メタ変数でワイルドカード |
| **PMD CPD** | Token normalization | 高速 | 識別子を正規化 |

### Type 3: Gapped Clone (構造変更あり)

文の追加・削除・並べ替えがある。

| ツール | アプローチ | 速度 |
|---|---|---|
| **ast-grep** | AST サブツリーマッチング | 高速 |
| **Tree-sitter + カスタム** | AST fingerprinting | 中速 |
| **Semgrep** | パターンベース | 高速 (lint 速度) |

### Type 4: Semantic Clone (意味的に同一だが実装が異なる)

異なるアルゴリズム・構文で同じ機能を実現。

| アプローチ | 技術 | 速度 | 精度 |
|---|---|---|---|
| **コード埋め込み + ベクトル検索** | Voyage AI / OpenAI | ~100ms/query | 高い (翻訳あり) |
| **自然言語記述 → 埋め込み** | LLM 要約 + embed | ~500ms | 最も高い |
| **Graph-based** | PDG/CFG similarity | 遅い | 非常に高い |

---

## 速度ベンチマークと Hook 適合性

**制約**: PostToolUse hook = 5秒、PreToolUse hook = 3秒

| アプローチ | 推定時間 | Hook 適合 | 備考 |
|---|---|---|---|
| jscpd (変更ファイルのみ) | 200-500ms | YES | 増分スキャン可能 |
| ast-grep パターン検索 | 50-200ms | YES | Rust 実装で最速 |
| Semgrep ルール | 100-500ms | YES | YAML ルールで柔軟 |
| PMD CPD (対象ディレクトリのみ) | 300-800ms | YES | JVM 起動が遅い場合あり |
| Voyage AI ベクトル検索 | 100-300ms | YES | 既に alfred に統合済み |
| Tree-sitter AST parse + fingerprint | 50-100ms | YES | カスタム実装が必要 |
| 自然言語変換 + embed | 500-2000ms | MARGINAL | LLM 呼び出し必要 |
| SonarQube full scan | 10-60s | NO | サーバー型 |

---

## 推奨実装戦略

### Phase 1: Pre-write RAG 検索 (最も ROI が高い)

**コンセプト**: Claude が新しいコードを書く前に、既存の類似コードを検索して注入する。

```
PostToolUse (Edit/Write) フロー:
1. 新しく書かれたコードから関数シグネチャを抽出
2. Voyage AI で既存コードベースを検索
3. 類似度が高い既存関数があれば DIRECTIVE で「既存の X を使え」と指示
```

**実装**:

```typescript
// PostToolUse で Edit/Write 後に実行
async function detectDuplicateFunction(
  cwd: string,
  newCode: string,
  filePath: string,
  signal: AbortSignal
): Promise<DirectiveItem[]> {
  const items: DirectiveItem[] = [];

  // 1. 新しい関数シグネチャを抽出 (正規表現 or tree-sitter)
  const newFunctions = extractFunctionSignatures(newCode);

  // 2. 各関数について既存 DB を検索
  for (const fn of newFunctions) {
    const query = `${fn.name} ${fn.params} ${fn.returnType}`;
    const hits = await searchKnowledgeSafe(cwd, query, "fix_pattern", signal);

    if (hits.length > 0 && hits[0].score > 0.85) {
      items.push({
        level: "WARNING",
        message: `Function "${fn.name}" may duplicate existing "${hits[0].name}" in ${hits[0].file}. Consider reusing instead of reimplementing.`,
      });
    }
  }

  return items;
}
```

### Phase 2: 関数シグネチャ DB (知識タイプ追加)

**新しい知識タイプ**: `function_signature`

```typescript
interface FunctionSignature {
  name: string;
  params: string;        // 正規化されたパラメータリスト
  returnType: string;
  filePath: string;
  description: string;   // JSDoc or LLM 生成の自然言語記述
  bodyHash: string;       // 関数本体の正規化ハッシュ
}
```

**蓄積タイミング**:
- SessionStart: プロジェクト全体をスキャン (初回のみ、以降は差分)
- PostToolUse (Edit/Write): 変更ファイルの関数シグネチャを更新

**検索タイミング**:
- PostToolUse (Edit/Write): 新しい関数が書かれたら類似検索
- UserPromptSubmit: 「XXX を実装して」→ 既存の類似関数を検索して注入

### Phase 3: jscpd 増分スキャン (テキストレベル重複)

```typescript
// PostToolUse で変更ファイルのみスキャン
import { detectClones } from "jscpd";

async function checkDuplicates(changedFiles: string[]): Promise<Clone[]> {
  return detectClones({
    path: changedFiles,
    minLines: 6,
    minTokens: 50,
    format: ["typescript", "javascript"],
    reporters: [],  // プログラマティック — レポーターなし
  });
}
```

### Phase 4: ast-grep パターンルール (構造的重複)

```yaml
# .ast-grep/rules/duplicate-utility.yml
id: duplicate-array-flatten
language: typescript
rule:
  any:
    - pattern: $ARR.reduce(($ACC, $ITEM) => $ACC.concat($ITEM), [])
    - pattern: $ARR.reduce(($ACC, $ITEM) => [...$ACC, ...$ITEM], [])
message: "Use Array.flat() instead of manual flatten implementation"
severity: warning
```

ast-grep は Rust 製で Tree-sitter ベース。数万ファイルを秒単位で処理可能。
カスタムルールで「このパターンの代わりにこの関数を使え」を定義できる。

---

## 技術的詳細

### 関数シグネチャ抽出 (TypeScript)

**軽量アプローチ**: 正規表現 (Hook に適合、外部依存なし)

```typescript
const FUNC_PATTERNS = [
  // function declarations
  /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/g,
  // arrow functions assigned to const/let
  /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)(?:\s*:\s*([^=]+))?\s*=>/g,
  // class methods
  /(?:async\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/g,
];
```

**重量アプローチ**: Tree-sitter (精度高いが依存追加)

```typescript
// @squirrelsoft/code-index: 1000+ files/sec, SQLite ベース
// Tree-sitter パーサーでフルシンボル抽出
// シグネチャ、コールグラフ、行範囲、種類 (function/class/interface)
```

### 類似度計算

**テキストハッシュ (Type 1-2)**:

```typescript
function normalizeAndHash(code: string): string {
  const normalized = code
    .replace(/\/\/.*$/gm, '')     // コメント除去
    .replace(/\/\*[\s\S]*?\*\//g, '') // ブロックコメント除去
    .replace(/\s+/g, ' ')         // 空白正規化
    .replace(/\b\w+(?=\s*[=:])/g, '_') // 識別子正規化
    .trim();
  return hash(normalized);
}
```

**ベクトル類似度 (Type 3-4)**:

Greptile のリサーチによる重要な知見:
1. **関数レベルの chunking が必須** — ファイルレベルだとノイズで類似度が劣化
   - 無関係ファイル: 0.718 / 対象関数含むファイル: 0.739 / 関数単体: 0.768
2. **コードを自然言語に変換してから embed** すると精度が 12% 向上
   - 自然言語クエリ vs コード: 0.7280 / 自然言語 vs 自然言語: 0.8152
3. Alfred の Voyage AI は既にこのパイプラインに適合

### 既存ツール比較サマリー

| ツール | 言語 | ランタイム | API | Hook 適合 | 推奨度 |
|---|---|---|---|---|---|
| **jscpd** | Node.js | Bun 互換 | programmatic | HIGH | Phase 3 |
| **ast-grep** | Rust (CLI) | バイナリ | CLI + JSON | HIGH | Phase 4 |
| **PMD CPD** | Java | JVM | CLI | LOW (JVM起動) | - |
| **Semgrep** | Python/OCaml | CLI | CLI + JSON | MEDIUM | パターンルール |
| **Voyage AI** | API | HTTP | REST | HIGH (既存) | Phase 1-2 |
| **@squirrelsoft/code-index** | Node.js | Bun 互換 | programmatic | HIGH | Phase 2 代替 |

---

## Alfred 統合設計

### 知識タイプ拡張

現在の 4 タイプに `function_index` を追加:

| タイプ | 蓄積 | 検索 |
|---|---|---|
| error_resolution | Bash エラー→成功 | Bash エラー時 |
| fix_pattern | fail→pass サイクル | 実装時 |
| convention | init + regex 違反 | SessionStart + Edit |
| decision | plan + commit | plan/design 時 |
| **function_index** (新) | **Edit/Write + init** | **Edit/Write 時 + UserPromptSubmit** |

### Hook フロー

```
UserPromptSubmit ("XXX を実装して")
  → function_index を Voyage 検索
  → 類似関数があれば CONTEXT 注入: "既存の utilX() が近い機能を持つ"

PostToolUse (Edit/Write)
  → 新関数シグネチャ抽出
  → function_index を Voyage 検索
  → 類似度 > 0.85: WARNING "既存の Y() を検討せよ"
  → 類似度 > 0.92: DIRECTIVE "Y() と重複。リファクタリングせよ"
  → jscpd 増分スキャン (テキスト重複)
  → 検出された重複を pending-fixes に追加

PreToolUse (Edit/Write)
  → pending-fixes に未解決の重複があれば DENY
  → ただし重複解消のための Edit は許可
```

### 段階的な厳しさ

```
類似度 0.70-0.85: CONTEXT (情報提示のみ)
  "FYI: src/utils/array.ts の flatten() が類似機能を持つ"

類似度 0.85-0.92: WARNING (強い推奨)
  "WARNING: 新しい flattenArray() は既存 flatten() と重複の可能性。確認せよ"

類似度 > 0.92: DIRECTIVE (修正必須)
  "DIRECTIVE: flattenArray() は flatten() (src/utils/array.ts:42) の重複。
   既存関数を再利用するか、統合リファクタリングせよ"
```

### 品質スコア統合

```
quality_score 計算に duplication_rate を追加:
  gate_write: 25% (現 30% から減)
  gate_commit: 20%
  error_resolution_hit: 15%
  convention: 10%
  duplication: 5% (新規)
  base: 25%
```

---

## 実装優先度

| 優先度 | フェーズ | 工数 | インパクト | 依存 |
|---|---|---|---|---|
| **P0** | Phase 1: Voyage 検索ベース重複検出 | 2-3日 | 高 | 既存インフラ活用 |
| **P1** | Phase 2: function_index 知識タイプ | 3-5日 | 高 | Phase 1 |
| **P2** | Phase 3: jscpd 増分スキャン | 1-2日 | 中 | npm dep 追加 |
| **P3** | Phase 4: ast-grep パターンルール | 1-2日 | 中 | バイナリ dep |

**Phase 1 が最も ROI が高い理由**:
- Voyage AI + SQLite は既に alfred に統合済み
- 関数シグネチャ抽出は正規表現で十分 (Hook の 5s 制約内)
- 既存の `searchKnowledgeSafe()` をそのまま活用可能
- 新しい依存ゼロ

---

## Sources

- [GitClear AI Code Quality 2025 Report](https://www.gitclear.com/ai_assistant_code_quality_2025_research)
- [Agentic Refactoring: An Empirical Study (arxiv:2511.04824)](https://arxiv.org/html/2511.04824)
- [Greptile: Codebases Are Uniquely Hard to Search Semantically](https://www.greptile.com/blog/semantic-codebase-search)
- [jscpd - Copy/Paste Detector](https://github.com/kucherenko/jscpd)
- [ast-grep - Structural Search/Rewrite Tool](https://ast-grep.github.io/)
- [PMD CPD - Finding Duplicated Code](https://pmd.github.io/pmd/pmd_userdocs_cpd)
- [Semgrep - Fast Static Analysis](https://semgrep.dev/)
- [@squirrelsoft/code-index](https://www.npmjs.com/package/@squirrelsoft/code-index)
- [CodeAnt AI - Duplicate Code Checker Tools](https://www.codeant.ai/blogs/best-duplicate-code-checker-tools)
- [Augment Code - 7 AI Agent Tactics for RAG-Driven Codebases](https://www.augmentcode.com/guides/7-ai-agent-tactics-for-multimodal-rag-driven-codebases)
- [Thoughtworks - Refactoring with AI](https://www.thoughtworks.com/en-us/insights/podcasts/technology-podcasts/refactoring-with-ai)
- [Code Churn as Defect Predictor (Microsoft Research)](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/icse05churn.pdf)
- [Greptile v3 Agentic Code Review](https://www.greptile.com/blog/greptile-v3-agentic-code-review)
- [RAG in Coding Agents](https://psiace.me/posts/rag-in-coding-agent/)
