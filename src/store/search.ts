/**
 * Search pipeline — Voyage AI vector search only (no FTS5 fallback).
 *
 * Pipeline: embed query → vector search → rerank → recency signal → hit_count tracking
 */
import type { Embedder } from "../embedder/index.js";
import type { KnowledgeRow, KnowledgeType } from "../types.js";
import type { Store } from "./index.js";
import { getKnowledgeByIDs, incrementHitCount } from "./knowledge.js";
import { vectorSearch } from "./vectors.js";

export interface ScoredResult {
	entry: KnowledgeRow;
	score: number;
	matchReason: string;
}

export interface SearchOptions {
	type?: KnowledgeType | "all";
	limit?: number;
	minScore?: number;
	trackHits?: boolean;
}

// Recency half-life in days per knowledge type
const HALF_LIFE: Record<string, number> = {
	error_resolution: 60,
	fix_pattern: 90,
	convention: 180,
	decision: 150,
};

/**
 * Search knowledge using Voyage AI vector search + rerank.
 */
export async function searchKnowledge(
	store: Store,
	emb: Embedder,
	query: string,
	opts: SearchOptions = {},
): Promise<ScoredResult[]> {
	const limit = opts.limit ?? 5;
	const minScore = opts.minScore ?? 0.70;
	const trackHits = opts.trackHits ?? true;

	// 1. Embed query
	const queryVec = await emb.embedForSearch(query);

	// 2. Vector search (cosine similarity)
	const vectorLimit = Math.max(limit * 3, 15); // fetch more for reranking
	const matches = vectorSearch(store, queryVec, vectorLimit, minScore);
	if (matches.length === 0) return [];

	// 3. Get knowledge entries
	const ids = matches.map((m) => m.sourceId);
	const entries = getKnowledgeByIDs(store, ids);
	if (entries.length === 0) return [];

	// Filter by type if specified
	const typeFilter = opts.type && opts.type !== "all" ? opts.type : null;
	const filtered = typeFilter
		? entries.filter((e) => e.type === typeFilter)
		: entries;
	if (filtered.length === 0) return [];

	// 4. Rerank
	const documents = filtered.map((e) => `${e.title}\n${e.content}`);
	const reranked = await emb.rerank(query, documents, Math.min(limit, filtered.length));

	// 5. Apply recency signal + build results
	const results: ScoredResult[] = [];
	for (const r of reranked) {
		const entry = filtered[r.index];
		if (!entry) continue;

		const recencyMultiplier = computeRecencyMultiplier(entry);
		const finalScore = r.relevanceScore * recencyMultiplier;

		results.push({
			entry,
			score: Math.round(finalScore * 1000) / 1000,
			matchReason: "semantic match",
		});
	}

	// 6. Track hit counts
	if (trackHits && results.length > 0) {
		incrementHitCount(store, results.map((r) => r.entry.id));
	}

	return results;
}

/**
 * Compute recency multiplier using half-life decay.
 * Recent entries get a boost, old entries get penalized.
 */
function computeRecencyMultiplier(entry: KnowledgeRow): number {
	const halfLife = HALF_LIFE[entry.type] ?? 90;
	const lastDate = entry.lastAccessed || entry.updatedAt || entry.createdAt;
	if (!lastDate) return 1.0;

	const daysSince = (Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24);
	// Exponential decay: 1.0 at day 0, 0.5 at halfLife days
	const decay = Math.pow(0.5, daysSince / halfLife);
	// Clamp between 0.3 and 1.2 (slight boost for very recent)
	return Math.max(0.3, Math.min(1.2, 0.2 + decay));
}
