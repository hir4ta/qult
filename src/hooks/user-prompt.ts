import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";
import { formatSearchHits, searchKnowledgeSafe } from "./knowledge-search.js";
import { readStateJSON, writeStateJSON } from "./state.js";

/**
 * UserPromptSubmit handler: Plan mode power-up + knowledge injection.
 *
 * Simple two-step detection:
 * 1. Exclude questions/reviews (hard filter)
 * 2. If any implementation keyword matches → DIRECTIVE
 */
export async function userPromptSubmit(ev: HookEvent, _signal: AbortSignal): Promise<void> {
	if (!ev.cwd) return;

	const prompt = (ev.prompt ?? "").toLowerCase();
	if (!prompt.trim()) return;

	const items: DirectiveItem[] = [];

	const intent = classifyIntent(prompt);

	// Plan mode detection: inject plan structure template
	if (isPlanMode(ev) || (wantsPlan(prompt) && !isExcluded(prompt))) {
		items.push({
			level: "DIRECTIVE",
			message:
				"You MUST structure your plan using this format:\n\n" +
				"## Context\n<Why this change is needed — problem, trigger, intended outcome>\n\n" +
				"## Phases\n" +
				"### Phase 1: <name>\n" +
				"- **Scope**: <what this phase covers>\n" +
				"- **Acceptance Criteria**: <measurable completion criteria>\n" +
				"- **Test Plan**: <how to verify>\n" +
				"- **Files**: <files to change>\n\n" +
				"(repeat for each phase)\n\n" +
				"## Phase Gates\n" +
				"After EACH phase: run tests, verify criteria, check regressions, self-review for simpler alternatives.\n\n" +
				"## Risks\n<potential issues and mitigations>",
			spiritVsLetter: true,
		});
	}

	if (intent === "implementation") {
		items.push({
			level: "DIRECTIVE",
			message:
				"You MUST:\n" +
				"(1) Write tests FIRST for each component before implementing\n" +
				"(2) Define acceptance criteria before implementing\n" +
				"(3) Keep each task under 200 lines of changes",
			spiritVsLetter: true,
			rationalizations: [
				'"Tests slow me down" — Tests prevent rework. Net time is lower.',
				'"This is too simple to need tests" — Simple code still needs regression protection.',
				'"I\'ll add tests after" — Post-hoc tests miss edge cases caught by test-first.',
			],
		});
	}

	// Exemplar + error_resolution injection (research #8: few-shot > rule list)
	if (intent === "implementation") {
		const hits = await searchKnowledgeSafe(prompt, {
			limit: 3,
			minScore: 0.75,
		});
		if (hits.length > 0) {
			const formatted = formatSearchHits(hits);
			items.push({
				level: "CONTEXT",
				message: `Relevant knowledge:\n${formatted}`,
			});
			// Record knowledge injection for TUI dashboard tracking
			recordKnowledgeInjection(ev.cwd, hits.length);
		}
	}

	if (isLargeTask(prompt)) {
		items.push({
			level: "WARNING",
			message:
				"This looks like a large task. Break it into sub-tasks of ~35 minutes each. " +
				"Task time 2x = failure rate 4x.",
		});
	}

	emitDirectives("UserPromptSubmit", items);
}

// ── Intent classification ───────────────────────────────────────────

export type PromptIntent = "implementation" | "question" | "neutral";

/**
 * Two-step intent classification:
 * 1. If excluded → "question" (hard filter, checked first)
 * 2. If negated → "neutral"
 * 3. If any impl keyword matches → "implementation"
 * 4. Otherwise → "neutral"
 */
export function classifyIntent(prompt: string): PromptIntent {
	if (isNegated(prompt)) return "neutral";
	if (isExcluded(prompt)) return "question";
	if (hasImplKeyword(prompt)) return "implementation";
	return "neutral";
}

// ── Step 1: Exclusion (question/review/info-seeking) ────────────────

function isExcluded(prompt: string): boolean {
	// Question mark at end
	if (/[？?]\s*$/.test(prompt)) return true;

	// English question starters
	if (
		/^(?:what|how|why|when|where|who|which|can|could|should|would|is|are|do|does|did)\s/i.test(
			prompt,
		)
	)
		return true;

	// English exclusion starters
	for (const prefix of EXCL_STARTS) {
		if (prompt.startsWith(prefix)) return true;
	}

	// Japanese question patterns
	if (/とは[？?]?\s*$/.test(prompt)) return true;
	if (/って何/.test(prompt)) return true;
	if (/^(?:なぜ|なんで|どう|どこ|いつ|だれ|どれ|どの)/.test(prompt)) return true;

	// Japanese exclusion starters
	for (const prefix of EXCL_STARTS_JA) {
		if (prompt.startsWith(prefix)) return true;
	}

	return false;
}

const EXCL_STARTS = [
	// question/explanation
	"explain ",
	"describe ",
	"tell me ",
	"show me ",
	"help me understand",
	"walk me through",
	"what is ",
	"what are ",
	"what does ",
	"what's ",
	// review/analysis
	"review ",
	"check ",
	"audit ",
	"inspect ",
	"analyze ",
	"evaluate ",
	"assess ",
	"summarize ",
	"summary ",
	"compare ",
	"debug ",
	"diagnose ",
	"investigate ",
	"trace ",
	// info
	"find ",
	"search ",
	"look for ",
	"look at ",
	"list ",
	"read ",
	"print ",
	"display ",
];

const EXCL_STARTS_JA = [
	"説明して",
	"教えて",
	"確認して",
	"見て",
	"見せて",
	"調べて",
	"読んで",
	"探して",
	"レビューして",
	"チェックして",
	"分析して",
	"解析して",
	"評価して",
	"要約して",
	"まとめて",
	"比較して",
	"デバッグして",
	"どう思う",
	"意見を",
];

// ── Step 2: Negation ────────────────────────────────────────────────

function isNegated(prompt: string): boolean {
	// English
	if (
		/(?:don'?t|do not|not yet|won'?t|shouldn'?t)\s+(?:implement|build|create|add|fix|remove|delete|refactor|update|change|modify|migrate)/i.test(
			prompt,
		)
	) {
		return true;
	}
	// Japanese
	if (
		/(?:実装|作成|追加|修正|削除|変更|構築|開発)(?:しない|するな|は不要|はまだ|はやめ)/.test(prompt)
	) {
		return true;
	}
	if (/まだ(?:実装|作成|追加|修正|削除|変更)(?:しない|するな|は)/.test(prompt)) {
		return true;
	}
	return false;
}

// ── Step 3: Implementation keyword match ────────────────────────────

function hasImplKeyword(prompt: string): boolean {
	for (const kw of IMPL_KEYWORDS) {
		if (prompt.includes(kw)) return true;
	}
	// English imperative: verb + object
	if (
		/\b(?:make|write|code|fix|update|change|modify|add|remove|delete|create|build|move|rename|replace|refactor|extract|split|merge|optimize|improve|convert|migrate|implement|generate|configure|enable|disable|introduce|wrap|extend|integrate)\s+(?:the|a|an|this|that|all|each|every|new|my|our)\b/i.test(
			prompt,
		)
	) {
		return true;
	}
	// Japanese imperative: して/しよう/進めて etc.
	if (/(?:して|しよう|進めて|始めて|やって|取り掛か)/.test(prompt)) return true;
	return false;
}

const IMPL_KEYWORDS = [
	// ── English ──────────────────────────────────────────────────
	// design/planning
	"plan",
	"design",
	"architect",
	"architecture",
	"prototype",
	"proof of concept",
	"poc",
	"spike",
	"mvp",
	// creation
	"implement",
	"build",
	"create",
	"develop",
	"write code",
	"generate",
	"scaffold",
	"bootstrap",
	"set up",
	"setup",
	"init",
	// modification
	"add feature",
	"new feature",
	"add support",
	"refactor",
	"restructure",
	"reorganize",
	"rearchitect",
	"update",
	"modify",
	"change",
	"alter",
	"adjust",
	"move",
	"rename",
	"relocate",
	"replace",
	"swap",
	"substitute",
	"switch to",
	"wrap",
	"extend",
	"compose",
	// removal
	"remove",
	"delete",
	"deprecate",
	"drop",
	// splitting/merging
	"extract",
	"split",
	"separate",
	"decouple",
	"merge",
	"combine",
	"consolidate",
	"unify",
	// improvement
	"optimize",
	"improve",
	"enhance",
	"speed up",
	"convert",
	"transform",
	"migrate",
	"upgrade",
	"port",
	"integrate",
	"connect",
	"wire up",
	"hook up",
	// fix
	"fix",
	"bugfix",
	"hotfix",
	"patch",
	"configure",
	"enable",
	"disable",
	"introduce",
	"support",
	"deduplicate",
	"inline",

	// ── Japanese ─────────────────────────────────────────────────
	// design/planning
	"設計",
	"アーキテクチャ",
	"プロトタイプ",
	"計画",
	"方針",
	// creation
	"実装",
	"構築",
	"作成",
	"作って",
	"作る",
	"開発",
	"書いて",
	"書く",
	"コーディング",
	"生成",
	"スキャフォールド",
	"セットアップ",
	"初期化",
	// modification
	"追加",
	"足して",
	"加えて",
	"修正",
	"直して",
	"直す",
	"バグ修正",
	"バグフィックス",
	"リファクタ",
	"リファクタリング",
	"再構成",
	"整理して",
	"更新",
	"変更",
	"変えて",
	"変える",
	"編集",
	"移動",
	"移して",
	"リネーム",
	"名前変更",
	"置き換え",
	"差し替え",
	"入れ替え",
	"切り替え",
	"設定",
	"有効化",
	"無効化",
	// removal
	"削除",
	"消して",
	"消す",
	"除去",
	"取り除",
	// splitting/merging
	"抽出",
	"切り出",
	"分割",
	"分離",
	"分けて",
	"マージ",
	"統合",
	"結合",
	// improvement
	"最適化",
	"改善",
	"高速化",
	"パフォーマンス",
	"変換",
	"移行",
	"マイグレーション",
	"アップグレード",
	"ポート",
	"連携",
	"接続",
	"組み込",
	"導入",
	"サポート",
	"対応",
];

// ── Large task detection ────────────────────────────────────────────

const LARGE_TASK_SIGNALS = [
	// English
	"complete rewrite",
	"rewrite from scratch",
	"from scratch",
	"overhaul",
	"full rewrite",
	"total rewrite",
	"migration",
	"major refactor",
	"large-scale",
	"large scale",
	"entire codebase",
	"entire project",
	"whole project",
	"whole codebase",
	"all files",
	"every file",
	"across the codebase",
	"end to end",
	"end-to-end",
	"e2e implementation",
	"redesign",
	"rearchitect",
	"replace all",
	"rewrite all",
	"new system",
	"new architecture",
	"breaking change",
	// Japanese
	"全体",
	"全面",
	"大規模",
	"全て",
	"全部",
	"すべて",
	"ゼロから",
	"一から",
	"スクラッチ",
	"書き直",
	"作り直",
	"やり直",
	"全ファイル",
	"全体的",
	"根本的",
	"フルリライト",
	"フルスクラッチ",
	"全面改修",
	"全面刷新",
	"アーキテクチャ刷新",
	"基盤刷新",
	"抜本的",
	"大幅",
];

function isLargeTask(prompt: string): boolean {
	for (const signal of LARGE_TASK_SIGNALS) {
		if (prompt.includes(signal)) return true;
	}
	return prompt.length > 800;
}

// ── Exemplar injection tracking ─────────────────────────────────────

const KNOWLEDGE_INJECTION_FILE = "knowledge-injections.json";

function recordKnowledgeInjection(cwd: string, count: number): void {
	try {
		const current = readStateJSON<{ count: number }>(cwd, KNOWLEDGE_INJECTION_FILE, { count: 0 });
		writeStateJSON(cwd, KNOWLEDGE_INJECTION_FILE, { count: current.count + count });
	} catch {
		/* fail-open */
	}
}

/** Read total knowledge injection count for this session. */
export function getKnowledgeInjectionCount(cwd: string): number {
	return readStateJSON<{ count: number }>(cwd, KNOWLEDGE_INJECTION_FILE, { count: 0 }).count;
}

// ── Plan mode detection ─────────────────────────────────────────────

const PLAN_SIGNALS = [
	"plan",
	"design",
	"architect",
	"approach",
	"strategy",
	"設計",
	"計画",
	"プラン",
	"方針",
	"アプローチ",
];

function isPlanMode(ev: HookEvent): boolean {
	return ev.permission_mode === "plan";
}

function wantsPlan(prompt: string): boolean {
	return PLAN_SIGNALS.some((s) => prompt.includes(s));
}
