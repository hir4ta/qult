import type { Embedder } from "../embedder/index.js";
import { searchKnowledgeFTS, subTypeBoost, subTypeHalfLife } from "../store/fts.js";
import type { Store } from "../store/index.js";
import {
	getKnowledgeByIDs,
	incrementHitCount,
	searchKnowledgeKeyword,
} from "../store/knowledge.js";
import { vectorSearchKnowledge } from "../store/vectors.js";
import type { KnowledgeRow } from "../types.js";

const RECENCY_FLOOR = 0.5;

export function truncate(s: string, maxLen: number): string {
	const runes = [...s];
	if (runes.length <= maxLen) return s;
	return `${runes.slice(0, maxLen).join("")}...`;
}

export function recencyFactor(createdAt: string, subType: string, now: Date): number {
	const halfLife = subTypeHalfLife(subType);
	if (halfLife <= 0) return 1.0;

	const parsed = Date.parse(createdAt);
	if (Number.isNaN(parsed)) return 1.0;

	const ageDays = (now.getTime() - parsed) / (1000 * 60 * 60 * 24);
	if (ageDays <= 0) return 1.0;

	const factor = Math.exp((-Math.LN2 * ageDays) / halfLife);
	return factor < RECENCY_FLOOR ? RECENCY_FLOOR : factor;
}

export interface ScoredDoc {
	doc: KnowledgeRow;
	score: number;
	matchReason: string;
}

export interface SearchResult {
	scoredDocs: ScoredDoc[];
	searchMethod: string;
	warnings: string[];
}

function applyRecencySignal(docs: KnowledgeRow[], method: string, now: Date): ScoredDoc[] {
	if (docs.length === 0) return [];

	const scored = docs.map((doc, i) => {
		const posScore = 1.0 / (i + 1);
		const rf = recencyFactor(doc.createdAt, doc.subType, now);
		const stb = subTypeBoost(doc.subType);
		return { doc, score: Math.round(posScore * rf * stb * 100) / 100, matchReason: method };
	});

	if (scored.length > 1) {
		scored.sort((a, b) => b.score - a.score);
	}

	return scored;
}

export async function searchPipeline(
	store: Store,
	emb: Embedder | null,
	query: string,
	limit: number,
	overRetrieve: number,
	precomputedVec?: number[],
): Promise<SearchResult> {
	const res: SearchResult = { scoredDocs: [], searchMethod: "", warnings: [] };
	let rawDocs: KnowledgeRow[] = [];

	if (emb) {
		try {
			const queryVec = precomputedVec ?? (await emb.embedForSearch(query));
			const matches = vectorSearchKnowledge(store, queryVec, overRetrieve);
			if (matches.length > 0) {
				const ids = matches.map((m) => m.sourceId);
				const docs = getKnowledgeByIDs(store, ids);
				// Preserve vector similarity ordering.
				const docMap = new Map(docs.map((d) => [d.id, d]));
				const ordered: KnowledgeRow[] = [];
				for (const id of ids) {
					const d = docMap.get(id);
					if (d) ordered.push(d);
				}
				rawDocs = ordered;
				res.searchMethod = "vector";

				// Rerank if we have more results than needed.
				if (rawDocs.length > limit) {
					try {
						const contents = rawDocs.map((d) => `${d.title}\n${d.content}`);
						const reranked = await emb.rerank(query, contents, limit);
						if (reranked.length > 0) {
							const reorderedDocs: KnowledgeRow[] = [];
							for (const r of reranked) {
								if (r.index >= 0 && r.index < rawDocs.length) {
									reorderedDocs.push(rawDocs[r.index]!);
								}
							}
							rawDocs = reorderedDocs;
							res.searchMethod = "vector+rerank";
						}
					} catch (err) {
						res.warnings.push(`rerank failed: ${err}`);
					}
				}
			}
		} catch (err) {
			res.warnings.push(`vector embedding failed: ${err}`);
		}
	}

	// Fallback to FTS5 search if no vector results.
	if (rawDocs.length === 0) {
		res.searchMethod = "fts5";
		try {
			rawDocs = searchKnowledgeFTS(store, query, limit);
		} catch (err) {
			res.warnings.push(`fts5 search failed: ${err}`);
			res.searchMethod = "keyword";
			try {
				rawDocs = searchKnowledgeKeyword(store, query, limit);
			} catch (err2) {
				res.warnings.push(`keyword search failed: ${err2}`);
			}
		}
	}

	// Exclude internal-only types (snapshots) from search results.
	rawDocs = rawDocs.filter((d) => d.subType !== "snapshot");

	// Apply recency signal and produce ScoredDoc[].
	res.scoredDocs = applyRecencySignal(rawDocs, res.searchMethod, new Date());

	if (res.scoredDocs.length > limit) {
		res.scoredDocs = res.scoredDocs.slice(0, limit);
	}

	return res;
}

const MIN_HIT_SCORE = 0.6;

export function trackHitCounts(store: Store, scoredDocs: ScoredDoc[]): void {
	if (scoredDocs.length === 0) return;
	const ids = scoredDocs
		.filter((sd) => sd.doc.id > 0 && sd.score >= MIN_HIT_SCORE)
		.map((sd) => sd.doc.id);
	if (ids.length === 0) return;
	incrementHitCount(store, ids);
}
