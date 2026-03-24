import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Embedder } from "../embedder/index.js";
import { searchPipeline, trackHitCounts, truncate } from "../mcp/helpers.js";
import { readActiveState } from "../spec/types.js";
import { openDefaultCached } from "../store/index.js";
import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";

// Intent classification for skill nudge.
const INTENT_KEYWORDS: Record<string, string[]> = {
	research: [
		"research",
		"investigate",
		"understand",
		"explore",
		"learn",
		"pattern",
		"調べ",
		"調査",
		"理解",
		"質問",
	],
	plan: ["plan", "design", "architect", "how to", "approach", "アーキテクチャ", "設計", "計画"],
	implement: ["implement", "add", "create", "build", "refactor", "追加", "実装", "リファクタ"],
	bugfix: ["fix", "bug", "error", "broken", "failing", "修正", "バグ", "エラー"],
	review: ["review", "check", "audit", "inspect", "レビュー", "確認"],
	tdd: ["test", "tdd", "spec", "テスト"],
	"save-knowledge": ["remember", "save", "note", "record", "覚え", "保存", "メモ"],
};

const INTENT_TO_SKILL: Record<string, string> = {
	research: "/alfred:brief",
	plan: "/alfred:attend",
	implement: "/alfred:attend",
	bugfix: "/alfred:mend",
	review: "/alfred:inspect",
	tdd: "/alfred:tdd",
};

const INTENT_DESCRIPTIONS: Record<string, string> = {
	research: "Investigating, researching, understanding code or concepts",
	plan: "Planning, designing, architecting a solution or approach",
	implement: "Implementing, adding, creating, building, refactoring code",
	bugfix: "Fixing a bug, resolving an error, debugging a problem",
	review: "Reviewing, checking, auditing, inspecting, validating code quality",
	tdd: "Writing tests, test-driven development, creating test specs",
	"save-knowledge": "Saving, remembering, recording information for later use",
};

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

	// Embed prompt once — reuse for intent classification + knowledge search.
	let emb: Embedder | null = null;
	let promptVec: number[] | null = null;
	try {
		emb = Embedder.create();
		promptVec = await emb.embedForSearch(prompt, signal);
	} catch {
		/* no Voyage key — FTS fallback */
	}

	const items: DirectiveItem[] = [];

	// Intent classification: semantic (if Voyage) → keyword fallback.
	let intent: string | null = null;
	if (emb && promptVec) {
		intent = await classifyIntentSemantic(emb, promptVec, signal);
	}
	if (!intent) {
		intent = classifyIntent(prompt);
	}

	// FR-5: Spec creation enforcement.
	const specDirective = checkSpecRequired(ev.cwd, intent);
	if (specDirective) {
		items.push(specDirective);
		// FR-7: User-facing explanation when spec creation is first required.
		if (specDirective.level === "DIRECTIVE") {
			const lang = process.env.ALFRED_LANG || "en";
			const msg = lang === "ja"
				? "alfred は仕様書 (spec) を使って開発を構造化します。specは自動で作成され、サイズも自動判定されます。実装の追跡・レビュー・ナレッジ蓄積を自動化し、品質を担保します。"
				: "alfred structures development with specs. Specs are created automatically with auto-detected sizing. Tracks implementation progress, enforces reviews, and accumulates knowledge.";
			items.push({ level: "CONTEXT", message: msg });
		}
	}

	// FR-1: Skill nudge with dismissal suppression.
	// FR-8: Suppress nudge for implement/review/plan when actively working on a spec.
	if (intent && intent !== "save-knowledge") {
		const skill = INTENT_TO_SKILL[intent];
		if (skill) {
			// Suppress nudge when actively implementing (active spec + slug in worked-slugs).
			const suppressIntents = new Set(["implement", "review", "plan", "bugfix", "tdd"]);
			let suppressed = false;
			if (suppressIntents.has(intent) && ev.cwd) {
				try {
					const state = readActiveState(ev.cwd);
					const primary = state.primary;
					const worked = readWorkedSlugs(ev.cwd);
					if (primary && worked.includes(primary)) {
						suppressed = true;
					}
				} catch { /* no active spec */ }
			}

			if (!suppressed) {
				const impressions = getNudgeImpressions(ev.cwd, intent);
				if (impressions < 3) {
					items.push({
						level: "CONTEXT",
						message: `Skill suggestion: ${skill} — ${intentDescription(intent)}`,
					});
					recordNudge(ev.cwd, intent);
				}
			}
		}
	}

	// Knowledge search — reuse promptVec to avoid double Voyage API call (DEC-2).
	const limit = 5;
	const result = await searchPipeline(store, emb, prompt, limit, limit * 3, promptVec ?? undefined);

	// FR-2 (knowledge-lifecycle): Gap detection — low score + implement intent.
	recordKnowledgeGap(ev.cwd, prompt, intent, result.scoredDocs);

	// FR-2: Knowledge results with natural language relevance explanation.
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
 * Semantic intent classification using Voyage embeddings.
 * Embeds intent descriptions in batch, compares with prompt vector.
 */
async function classifyIntentSemantic(
	emb: Embedder,
	promptVec: number[],
	signal: AbortSignal,
): Promise<string | null> {
	try {
		const intents = Object.keys(INTENT_DESCRIPTIONS);
		const descriptions = intents.map((k) => INTENT_DESCRIPTIONS[k]!);
		// Intent descriptions embedded as documents, prompt as query — correct asymmetric usage
		// for Voyage's query-document embedding model.
		const intentVecs = await emb.embedBatchForStorage(descriptions, signal);

		let bestIntent = "";
		let bestScore = 0;
		for (let i = 0; i < intents.length; i++) {
			const score = cosineSim(promptVec, intentVecs[i]!);
			if (score > bestScore) {
				bestScore = score;
				bestIntent = intents[i]!;
			}
		}

		return bestScore >= 0.5 ? bestIntent : null;
	} catch {
		return null; // Voyage failure → fall through to keyword
	}
}

export function cosineSim(a: number[], b: number[]): number {
	let dot = 0,
		na = 0,
		nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom > 0 ? dot / denom : 0;
}

export function classifyIntent(prompt: string): string | null {
	const lower = prompt.toLowerCase();
	let bestIntent = "";
	let bestScore = 0;

	for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
		let score = 0;
		for (const kw of keywords) {
			if (lower.includes(kw)) score++;
		}
		if (score > bestScore) {
			bestScore = score;
			bestIntent = intent;
		}
	}

	// save-knowledge suppresses research when both match.
	if (bestIntent === "research") {
		let saveScore = 0;
		for (const kw of INTENT_KEYWORDS["save-knowledge"]!) {
			if (lower.includes(kw)) saveScore++;
		}
		if (saveScore > 0) return "save-knowledge";
	}

	return bestScore > 0 ? bestIntent : null;
}

/**
 * FR-5: Propose spec creation before implementation (DIRECTIVE level).
 * Stage 1: No spec exists → DIRECTIVE to ask user about spec creation.
 * Stage 1.5: Spec exists + implement intent → WARNING to confirm or create new spec.
 */
export function checkSpecRequired(cwd: string, intent: string | null): DirectiveItem | null {
	if (!intent || !["implement", "bugfix", "tdd"].includes(intent)) return null;

	// Only enforce in alfred-initialized projects.
	if (!existsSync(join(cwd, ".alfred"))) return null;

	// Stage 1: No active spec → DIRECTIVE to ask user about spec creation.
	// Always propose, never silently skip. User can say "skip" to proceed without spec.
	// Guard resets per session (SessionStart clears spec-prompt.json).
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

	// Stage 1.5: Spec exists + implement intent → WARNING for parallel dev safety.
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

export function intentDescription(intent: string): string {
	switch (intent) {
		case "research":
			return "Research and investigation structuring";
		case "plan":
			return "Spec creation → implementation";
		case "implement":
			return "Spec creation → implementation";
		case "bugfix":
			return "Reproduce → analyze → fix → verify";
		case "review":
			return "6-profile quality review";
		case "tdd":
			return "Red → Green → Refactor autonomous TDD";
		default:
			return "";
	}
}

// --- FR-1: Nudge dismissal tracking via .alfred/.state/ (survives across short-lived hook processes) ---

import { ensureStateDir, readStateJSON, readWorkedSlugs, writeStateJSON } from "./state.js";

interface NudgeCounts {
	[intent: string]: { count: number; lastNudged: string };
}

/** Get how many times this intent's nudge was shown. Suppressed after 3 impressions. */
function getNudgeImpressions(cwd: string, intent: string): number {
	const counts = readStateJSON<NudgeCounts>(cwd, "nudge-dismissals.json", {});
	return counts[intent]?.count ?? 0;
}

/** Record that we nudged this intent. If the user doesn't act on it, this counts as a dismissal. */
function recordNudge(cwd: string, intent: string): void {
	const counts = readStateJSON<NudgeCounts>(cwd, "nudge-dismissals.json", {});
	const entry = counts[intent] ?? { count: 0, lastNudged: "" };
	entry.count++;
	entry.lastNudged = new Date().toISOString();
	counts[intent] = entry;
	writeStateJSON(cwd, "nudge-dismissals.json", counts);
}

/** Reset nudge count for an intent (called when user actually follows the nudge). */
export function resetNudgeCount(cwd: string, intent: string): void {
	const counts = readStateJSON<NudgeCounts>(cwd, "nudge-dismissals.json", {});
	delete counts[intent];
	writeStateJSON(cwd, "nudge-dismissals.json", counts);
}

// --- FR-2: Natural language relevance explanation ---

import type { ScoredDoc } from "../mcp/helpers.js";
import { subTypeBoost } from "../store/fts.js";

export function buildRelevanceExplanation(sd: ScoredDoc): string {
	const parts: string[] = [];

	// Search method explanation.
	if (sd.matchReason === "vector+rerank") {
		parts.push("semantic match (reranked)");
	} else if (sd.matchReason === "vector") {
		parts.push("semantic match");
	} else if (sd.matchReason === "fts5") {
		parts.push("keyword match");
	}

	// Sub-type boost.
	const boost = subTypeBoost(sd.doc.subType);
	if (boost > 1.0) {
		parts.push(`${sd.doc.subType} boost ${boost}x`);
	}

	// Age context.
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

// --- FR-2 (knowledge-lifecycle): Knowledge Gap Detection ---

const GAP_INTENTS = new Set(["implement", "bugfix", "tdd"]);
const GAP_SCORE_THRESHOLD = 0.3;
const GAP_MAX_ENTRIES = 250;
const GAP_PRUNE_AGE_MS = 30 * 86400000; // 30 days

/**
 * Record a knowledge gap when search results are poor for actionable intents.
 */
function recordKnowledgeGap(
	projectPath: string,
	prompt: string,
	intent: string | null,
	scoredDocs: ScoredDoc[],
): void {
	if (!intent || !GAP_INTENTS.has(intent)) return;

	const bestScore = scoredDocs.length > 0 ? scoredDocs[0]!.score : 0;
	if (bestScore >= GAP_SCORE_THRESHOLD) return;

	const gapsPath = join(projectPath, ".alfred", ".state", "knowledge-gaps.jsonl");

	// Record the gap.
	let activeSlug: string | undefined;
	try {
		const state = readActiveState(projectPath);
		activeSlug = state.primary || undefined;
	} catch { /* no active spec */ }

	const entry = {
		query: prompt.slice(0, 200),
		intent,
		best_score: Math.round(bestScore * 100) / 100,
		result_count: scoredDocs.length,
		timestamp: new Date().toISOString(),
		...(activeSlug ? { spec_slug: activeSlug } : {}),
	};

	try {
		ensureStateDir(projectPath);
		appendFileSync(gapsPath, `${JSON.stringify(entry)}\n`);
	} catch { return; }

	// Pruning: only when > GAP_MAX_ENTRIES.
	try {
		const raw = readFileSync(gapsPath, "utf-8");
		const lines = raw.split("\n").filter((l) => l.trim());
		if (lines.length <= GAP_MAX_ENTRIES) return;

		const cutoff = new Date(Date.now() - GAP_PRUNE_AGE_MS).toISOString();
		const kept = lines.filter((l) => {
			try {
				const e = JSON.parse(l) as { timestamp?: string };
				return (e.timestamp ?? "") >= cutoff;
			} catch { return true; }
		});
		writeFileSync(gapsPath, `${kept.join("\n")}\n`);
	} catch { /* pruning is best-effort */ }
}
