import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Embedder } from "../embedder/index.js";
import type { Store } from "../store/index.js";
import { handleDossier } from "./dossier/index.js";
import { handleLedger } from "./ledger.js";

const SERVER_INSTRUCTIONS = `alfred is your development butler for Claude Code.

When to use alfred tools:
- Starting a new development task → call dossier with action=init
- Making design decisions → call dossier with action=update
- Starting/resuming a session → call dossier with action=status
- Searching past experiences or saving notes → call ledger
`;

export function createMCPServer(store: Store, emb: Embedder | null, version: string): McpServer {
	const server = new McpServer({ name: "alfred", version }, { instructions: SERVER_INSTRUCTIONS });

	server.tool(
		"dossier",
		`Unified spec management for development tasks. Persists context across compaction and sessions.

Actions: status (read-only), init, update, switch, complete, delete (2-phase: preview then confirm=true), history, rollback, review, validate (read-only), gate (review gate management), check (mark task completed), defer (toggle deferred/resume), cancel.

task_slug format: lowercase alphanumeric with hyphens (e.g. "my-feature", max 64 chars).
Size-based scaling: init accepts size (S/M/L) and spec_type (feature/bugfix). S=3 files, M=4 files, L=5 files.`,
		{
			action: z
				.enum([
					"init",
					"update",
					"status",
					"switch",
					"complete",
					"delete",
					"history",
					"rollback",
					"review",
					"validate",
					"gate",
					"check",
					"defer",
					"cancel",
				])
				.describe("Action to perform"),
			project_path: z.string().optional().describe("Project root path (defaults to cwd)"),
			task_slug: z.string().optional().describe("Task identifier"),
			description: z.string().optional().describe("Brief task description (for init)"),
			file: z
				.enum([
					"requirements.md",
					"design.md",
					"tasks.md",
					"test-specs.md",
					"decisions.md",
					"research.md",
					"session.md",
					"bugfix.md",
				])
				.optional()
				.describe("Spec file (for update/history/rollback)"),
			content: z.string().optional().describe("Content to write (for update)"),
			mode: z.enum(["append", "replace"]).optional().describe("Write mode (for update)"),
			size: z.enum(["S", "M", "L"]).optional().describe("Spec size for init"),
			spec_type: z.enum(["feature", "bugfix"]).optional().describe("Spec type for init"),
			version: z.string().optional().describe("Version timestamp for rollback"),
			confirm: z
				.boolean()
				.optional()
				.describe("Required for delete: preview first, then confirm=true"),
			sub_action: z
				.enum(["set", "clear", "fix", "status"])
				.optional()
				.describe("Gate sub-action (for gate action)"),
			gate_type: z
				.enum(["spec-review", "wave-review"])
				.optional()
				.describe("Gate type (for gate set)"),
			wave: z.number().optional().describe("Wave number (for gate set type=wave-review)"),
			reason: z
				.string()
				.optional()
				.describe("Review summary (required for gate clear)"),
			task_id: z
				.string()
				.optional()
				.describe('Task ID to mark as completed (for check action, e.g. "T-1.2")'),
		},
		async (params) => {
			return handleDossier(store, emb, params);
		},
	);

	const lang = (process.env.ALFRED_LANG || "en").toLowerCase();
	const ledgerDesc =
		lang === "ja"
			? `ナレッジの検索・保存・管理。セッションやプロジェクトを跨いで検索可能。

Actions:
- search: 過去のナレッジを検索
- save: 新しいナレッジを保存（下記ガイドに従うこと）
- promote: pattern→rule に昇格
- candidates: 昇格候補の一覧
- reflect: ヘルスレポート（統計、矛盾検出、昇格候補）

## save ガイド（全フィールドを日本語で記述すること）

### decision（意思決定）— 技術的な選択とその根拠
- title: 1行の要約（例: 「認証にJWTではなくセッションCookieを採用」）
- decision: 何を決めたか（例: 「セッションCookieベースの認証を採用する」）
- reasoning: なぜその選択か、具体的な根拠（例: 「XSSリスク軽減のため。HttpOnly + SameSiteで保護可能」）
- alternatives: 却下した選択肢と理由を改行区切りで（例: 「JWT: トークン失効管理が複雑」）
- context_text: 背景・制約条件

### pattern（パターン）— 再利用可能な手法・アンチパターン
- title: 1行の要約（例: 「大規模リファクタリング前にgrepで影響範囲を列挙する」）
- pattern_type: good（推奨）/ bad（アンチパターン）/ error-solution（エラー解決策）
- pattern: 問題と解決策を具体的に（例: 「問題: 変更漏れによるランタイムエラー。解決: grep -r で全参照を列挙してからリファクタ開始」）
- application_conditions: いつ適用するか / しないか
- expected_outcomes: 期待される結果

### rule（ルール）— 常に従うべき規約
- title: 1行の要約（例: 「テストではモックDBではなく実DBを使用する」）
- key: 機械可読キー（例: use-real-db-in-tests）
- text: 命令形のルール本文（例: 「テストでは常に実データベースに接続すること。モックDBは使用禁止」）
- priority: p0（必須）/ p1（推奨）/ p2（参考）
- rationale: なぜこのルールが必要か
- category: 分類（style / security / architecture / testing）`
			: `Long-term knowledge search, save, and management — searchable across sessions and projects.

Actions:
- search: Search past knowledge entries
- save: Save a new knowledge entry (follow the guide below)
- promote: Promote pattern→rule
- candidates: List promotion candidates
- reflect: Health report — stats, conflicts, promotion candidates

## save guide (write all fields in English)

### decision — Technical choices and their rationale
- title: One-line summary (e.g. "Adopt session cookies over JWT for auth")
- decision: What was decided (e.g. "Use session cookie-based authentication")
- reasoning: Why this choice, with specific rationale (e.g. "Reduces XSS risk. HttpOnly + SameSite provides protection")
- alternatives: Rejected alternatives with reasons, newline-separated (e.g. "JWT: token revocation management is complex")
- context_text: Background and constraints

### pattern — Reusable techniques or anti-patterns
- title: One-line summary (e.g. "Grep all references before large-scale refactoring")
- pattern_type: good (recommended) / bad (anti-pattern) / error-solution (error fix)
- pattern: Problem and solution concretely (e.g. "Problem: runtime errors from missed references. Solution: grep -r all references before starting refactor")
- application_conditions: When to apply / when NOT to apply
- expected_outcomes: Expected results

### rule — Conventions to always follow
- title: One-line summary (e.g. "Use real DB, not mocks, in tests")
- key: Machine-readable key (e.g. use-real-db-in-tests)
- text: Imperative rule text (e.g. "Always connect to a real database in tests. Mock DBs are prohibited")
- priority: p0 (must) / p1 (should) / p2 (reference)
- rationale: Why this rule is needed
- category: Classification (style / security / architecture / testing)`;

	server.tool(
		"ledger",
		ledgerDesc,
		{
			action: z
				.enum(["search", "save", "promote", "candidates", "reflect", "stale", "audit-conventions"])
				.describe("Action to perform"),
			id: z.number().optional().describe("Record ID (required for promote)"),
			query: z.string().optional().describe("Search query"),
			label: z
				.string()
				.optional()
				.describe("Short label for saved entry, natural language (REQUIRED for save)"),
			limit: z.number().optional().describe("Maximum search results (default: 10)"),
			detail: z.enum(["compact", "summary", "full"]).optional().describe("Response verbosity"),
			sub_type: z
				.enum(["decision", "pattern", "rule"])
				.optional()
				.describe("Knowledge type (REQUIRED for save)"),
			title: z
				.string()
				.optional()
				.describe(
					"Natural language title, max 200 chars. NOT JSON. (REQUIRED for save)",
				),
			// Decision fields
			decision: z
				.string()
				.optional()
				.describe(
					"Decision: what was decided, in plain text (REQUIRED for decision)",
				),
			reasoning: z
				.string()
				.optional()
				.describe(
					"Decision: why this choice, with specific rationale (REQUIRED for decision)",
				),
			alternatives: z
				.string()
				.optional()
				.describe(
					"Decision: rejected alternatives with reasons, newline-separated",
				),
			context_text: z
				.string()
				.optional()
				.describe("Background, constraints, or trigger for this knowledge entry"),
			// Pattern fields
			pattern_type: z
				.enum(["good", "bad", "error-solution"])
				.optional()
				.describe("Pattern classification (REQUIRED for pattern)"),
			pattern: z
				.string()
				.optional()
				.describe(
					"Pattern: problem and solution in plain text (REQUIRED for pattern)",
				),
			application_conditions: z
				.string()
				.optional()
				.describe("Pattern: when to apply / when NOT to apply"),
			expected_outcomes: z
				.string()
				.optional()
				.describe("Pattern: expected results when applied"),
			// Rule fields
			key: z
				.string()
				.optional()
				.describe("Rule: machine-readable key, kebab-case (REQUIRED for rule)"),
			text: z
				.string()
				.optional()
				.describe(
					"Rule: imperative text — what to do or not do (REQUIRED for rule)",
				),
			category: z
				.string()
				.optional()
				.describe("Rule: category (style / security / architecture / testing)"),
			priority: z.enum(["p0", "p1", "p2"]).optional().describe("Rule: p0=must, p1=should, p2=reference"),
			rationale: z.string().optional().describe("Rule: why this rule is needed"),
			source_ref: z
				.string()
				.optional()
				.describe('Rule: source reference JSON {"type":"pattern","id":"..."}'),
			// Common
			tags: z.string().optional().describe("Comma-separated tags for search"),
			project_path: z.string().optional().describe("Project root path"),
		},
		async (params) => {
			return handleLedger(store, emb, params);
		},
	);

	return server;
}

export async function serveMCP(store: Store, emb: Embedder | null, version: string): Promise<void> {
	const server = createMCPServer(store, emb, version);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
