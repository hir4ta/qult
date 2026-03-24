import { Embedder } from "../embedder/index.js";
import { searchPipeline, trackHitCounts, truncate } from "../mcp/helpers.js";
import { openDefaultCached } from "../store/index.js";
import { subTypeBoost } from "../store/fts.js";
import type { ScoredDoc } from "../mcp/helpers.js";
import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";

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

	// Knowledge search — reuse promptVec to avoid double Voyage API call (DEC-2).
	const limit = 5;
	const result = await searchPipeline(store, emb, prompt, limit, limit * 3, promptVec ?? undefined);

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
