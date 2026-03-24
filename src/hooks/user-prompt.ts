import { existsSync } from "node:fs";
import { join } from "node:path";
import { Embedder } from "../embedder/index.js";
import { searchPipeline, trackHitCounts, truncate } from "../mcp/helpers.js";
import { readActiveState } from "../spec/types.js";
import { openDefaultCached } from "../store/index.js";
import { subTypeBoost } from "../store/fts.js";
import type { ScoredDoc } from "../mcp/helpers.js";
import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";
import { classifyIntent } from "./llm.js";
import { readStateJSON, readWorkedSlugs, writeStateJSON } from "./state.js";

// Simplified implementation-intent check for spec proposal guard (DEC-4).
// Word-boundary matching to avoid false positives on common words like "add a comment".
const IMPL_PATTERNS = [
	/\bimplement/i, /\brefactor/i, /\bbugfix/i, /\btdd\b/i,
	/\bfix\s+(the\s+)?bug/i, /\bfix\s+(the\s+)?error/i, /\bfix\s+(the\s+)?issue/i,
	/\bbug\s+(fix|in|with|report)/i,
	/実装/, /リファクタ/, /バグ/, /修正/,
];

function looksLikeImplementation(prompt: string): boolean {
	return IMPL_PATTERNS.some((re) => re.test(prompt));
}

export async function userPromptSubmit(ev: HookEvent, signal: AbortSignal): Promise<void> {
	if (!ev.prompt || !ev.cwd) return;

	const prompt = ev.prompt.trim();
	if (!prompt) return;

	let store;
	try {
		store = openDefaultCached();
	} catch {
		return;
	}

	// Embed prompt for knowledge search (Voyage if available, FTS5 fallback).
	let emb: Embedder | null = null;
	let promptVec: number[] | null = null;
	try {
		emb = Embedder.create();
		promptVec = await emb.embedForSearch(prompt, signal);
	} catch {
		/* no Voyage key — FTS fallback */
	}

	const items: DirectiveItem[] = [];

	// FR-2: Spec proposal guard (simplified keyword check, Stage 1 + 1.5).
	const specDirective = checkSpecRequired(ev.cwd, prompt);
	if (specDirective) {
		items.push(specDirective);
		if (specDirective.level === "DIRECTIVE") {
			const lang = process.env.ALFRED_LANG || "en";
			const msg = lang === "ja"
				? "alfred は仕様書 (spec) を使って開発を構造化します。specは自動で作成され、サイズも自動判定されます。実装の追跡・レビュー・ナレッジ蓄積を自動化し、品質を担保します。"
				: "alfred structures development with specs. Specs are created automatically with auto-detected sizing. Tracks implementation progress, enforces reviews, and accumulates knowledge.";
			items.push({ level: "CONTEXT", message: msg });
		}
	}

	// Run knowledge search and intent classification in parallel.
	const limit = 5;
	const [result, intentResult] = await Promise.all([
		searchPipeline(store, emb, prompt, limit, limit * 3, promptVec ?? undefined),
		classifyIntent(prompt, signal),
	]);

	// Intent classification → skill suggestion.
	if (intentResult?.skill) {
		items.push({
			level: "CONTEXT",
			message: `Skill suggestion: ${intentResult.skill} (${intentResult.intent})`,
		});
	}

	// Knowledge results with relevance context.
	if (result.scoredDocs.length > 0) {
		trackHitCounts(store, result.scoredDocs);
		const contextLines = result.scoredDocs.map((sd) => {
			const sub = sd.doc.subType !== "snapshot" ? sd.doc.subType : "";
			const scoreStr = sd.score.toFixed(2);
			const prefix = sub
				? `[${sub}|${scoreStr}|${sd.matchReason}]`
				: `[${scoreStr}|${sd.matchReason}]`;
			const explanation = buildRelevanceExplanation(sd);
			return `- ${prefix} ${sd.doc.title}: ${truncate(sd.doc.content, 150)}${explanation}`;
		});
		items.push({
			level: "CONTEXT",
			message: `Related knowledge:\n${contextLines.join("\n")}`,
		});
	}

	emitDirectives("UserPromptSubmit", items);
}

/**
 * FR-2: Spec proposal guard (simplified, no intent classification dependency).
 * Stage 1: No active spec + implementation keywords → DIRECTIVE to ask user.
 * Stage 1.5: Spec exists + implementation keywords + slug not in worked-slugs → WARNING.
 */
export function checkSpecRequired(cwd: string, prompt: string): DirectiveItem | null {
	if (!looksLikeImplementation(prompt)) return null;

	// Only enforce in alfred-initialized projects.
	if (!existsSync(join(cwd, ".alfred"))) return null;

	// Stage 1: No active spec → DIRECTIVE to ask user about spec creation.
	let state;
	try {
		state = readActiveState(cwd);
	} catch {
		const prompted = readStateJSON<{ prompted?: boolean }>(cwd, "spec-prompt.json", {});
		if (prompted.prompted) return null;

		const lang = (process.env.ALFRED_LANG || "en").toLowerCase();
		writeStateJSON(cwd, "spec-prompt.json", { prompted: true, at: new Date().toISOString() });
		return {
			level: "DIRECTIVE",
			message: lang.startsWith("ja")
				? "新しい実装タスクです。AskUserQuestion で「spec を作成しますか？ (S/M/L/スキップ)」とユーザーに確認してください。ユーザーが「スキップ」を選んだ場合、そのまま実装に進んでください。"
				: "New implementation task. Use AskUserQuestion to ask the user: 'Create a spec? (S/M/L/Skip)'. If the user selects Skip, proceed without a spec.",
		};
	}

	// Stage 1.5: Spec exists + implementation keywords + slug not in worked-slugs → WARNING.
	try {
		const taskSlug = state.primary;
		if (taskSlug) {
			const workedSlugs = readWorkedSlugs(cwd);
			if (!workedSlugs.includes(taskSlug)) {
				return {
					level: "WARNING",
					message: `Active spec '${taskSlug}' exists. If this is a different task, create a new spec first via /alfred:brief or dossier action=init. Use AskUserQuestion to confirm with the user whether this work is part of '${taskSlug}' or a new task.`,
				};
			}
		}
	} catch {
		/* ignore parse errors */
	}

	return null;
}

// --- Relevance explanation for knowledge search results ---

function buildRelevanceExplanation(sd: ScoredDoc): string {
	const parts: string[] = [];

	if (sd.matchReason === "vector+rerank") {
		parts.push("semantic match (reranked)");
	} else if (sd.matchReason === "vector") {
		parts.push("semantic match");
	} else if (sd.matchReason === "fts5") {
		parts.push("keyword match");
	}

	const boost = subTypeBoost(sd.doc.subType);
	if (boost > 1.0) {
		parts.push(`${sd.doc.subType} boost ${boost}x`);
	}

	const ageDays = Math.floor((Date.now() - Date.parse(sd.doc.createdAt)) / (1000 * 60 * 60 * 24));
	if (ageDays <= 1) {
		parts.push("today");
	} else if (ageDays <= 7) {
		parts.push(`${ageDays}d ago`);
	} else if (ageDays <= 30) {
		parts.push(`${Math.floor(ageDays / 7)}w ago`);
	}

	return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}
