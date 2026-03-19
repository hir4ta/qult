import type { Store } from "./index.js";
import { expandAliases } from "./fts.js";
import { cosineSimilarity, deserializeFloat32 } from "./vectors.js";

export interface GraphEdge {
	source: number;
	target: number;
	score: number;
}

export interface GraphEdgesResult {
	edges: GraphEdge[];
	method: "vector" | "keyword";
	truncated: boolean;
}

interface VectorDoc {
	id: number;
	vec: number[];
}

interface SimilarityPair {
	idA: number;
	idB: number;
	score: number;
}

/**
 * Compute pairwise cosine similarity between all stored embeddings.
 * Shared utility used by both graph edges and conflict detection.
 * @param minScore - minimum similarity to include (filters inside the loop to avoid huge arrays)
 */
export function pairwiseSimilarity(
	store: Store,
	options?: { limit?: number; minScore?: number },
): SimilarityPair[] {
	const limit = options?.limit ?? 1000;
	const minScore = options?.minScore ?? 0;

	const rows = store.db
		.prepare(`
    SELECT e.source_id, e.vector FROM embeddings e
    JOIN knowledge_index k ON k.id = e.source_id
    WHERE e.source = 'knowledge' AND k.enabled = 1
    LIMIT ?
  `)
		.all(limit) as Array<{ source_id: number; vector: Buffer }>;

	const docs: VectorDoc[] = rows.map((r) => ({
		id: r.source_id,
		vec: deserializeFloat32(r.vector),
	}));

	const pairs: SimilarityPair[] = [];
	for (let i = 0; i < docs.length; i++) {
		for (let j = i + 1; j < docs.length; j++) {
			if (docs[i]!.vec.length !== docs[j]!.vec.length) continue;
			const sim = cosineSimilarity(docs[i]!.vec, docs[j]!.vec);
			if (sim >= minScore) {
				pairs.push({ idA: docs[i]!.id, idB: docs[j]!.id, score: sim });
			}
		}
	}

	return pairs;
}

/**
 * Compute graph edges for knowledge visualization.
 * Uses vector similarity when embeddings exist, falls back to keyword-based edges.
 */
export function computeGraphEdges(
	store: Store,
	options?: {
		threshold?: number;
		maxEdgesPerNode?: number;
		limit?: number;
	},
): GraphEdgesResult {
	const threshold = options?.threshold ?? 0.45;
	const maxEdgesPerNode = options?.maxEdgesPerNode ?? 10;
	const limit = options?.limit ?? 1000;

	// Check if embeddings exist
	const embCount = store.db
		.prepare(`
    SELECT COUNT(*) as cnt FROM embeddings e
    JOIN knowledge_index k ON k.id = e.source_id
    WHERE e.source = 'knowledge' AND k.enabled = 1
  `)
		.get() as { cnt: number };

	if (embCount.cnt > 0) {
		return computeVectorEdges(store, threshold, maxEdgesPerNode, limit);
	}

	return computeKeywordEdges(store, maxEdgesPerNode, limit);
}

function computeVectorEdges(
	store: Store,
	threshold: number,
	maxEdgesPerNode: number,
	limit: number,
): GraphEdgesResult {
	// Check truncation
	const totalCount = store.db
		.prepare("SELECT COUNT(*) as cnt FROM knowledge_index WHERE enabled = 1")
		.get() as { cnt: number };
	const truncated = totalCount.cnt > limit;

	const pairs = pairwiseSimilarity(store, { limit, minScore: threshold });

	// Sort by score desc for top-K selection
	pairs.sort((a, b) => b.score - a.score);

	// Apply per-node top-K limit
	const edgeCounts = new Map<number, number>();
	const edges: GraphEdge[] = [];

	for (const pair of pairs) {
		const countA = edgeCounts.get(pair.idA) ?? 0;
		const countB = edgeCounts.get(pair.idB) ?? 0;
		if (countA >= maxEdgesPerNode && countB >= maxEdgesPerNode) continue;

		edges.push({ source: pair.idA, target: pair.idB, score: pair.score });
		edgeCounts.set(pair.idA, countA + 1);
		edgeCounts.set(pair.idB, countB + 1);
	}

	return { edges, method: "vector", truncated };
}

function computeKeywordEdges(
	store: Store,
	maxEdgesPerNode: number,
	limit: number,
): GraphEdgesResult {
	const totalCount = store.db
		.prepare("SELECT COUNT(*) as cnt FROM knowledge_index WHERE enabled = 1")
		.get() as { cnt: number };
	const truncated = totalCount.cnt > limit;

	const rows = store.db
		.prepare(`
    SELECT id, title, content FROM knowledge_index
    WHERE enabled = 1
    ORDER BY hit_count DESC
    LIMIT ?
  `)
		.all(limit) as Array<{ id: number; title: string; content: string }>;

	// Extract and normalize keywords for each entry
	const docKeywords = rows.map((r) => ({
		id: r.id,
		keywords: extractKeywords(store, r.title, r.content),
	}));

	// Compute pairwise Jaccard similarity
	const edges: GraphEdge[] = [];
	const edgeCounts = new Map<number, number>();
	const kwMaxEdges = Math.min(maxEdgesPerNode, 5);
	const kwThreshold = 0.15;

	// Collect all candidate pairs with scores
	const candidates: GraphEdge[] = [];
	for (let i = 0; i < docKeywords.length; i++) {
		for (let j = i + 1; j < docKeywords.length; j++) {
			const a = docKeywords[i]!;
			const b = docKeywords[j]!;
			const score = jaccardSimilarity(a.keywords, b.keywords);
			if (score >= kwThreshold) {
				candidates.push({ source: a.id, target: b.id, score });
			}
		}
	}

	// Sort by score desc and apply per-node limit
	candidates.sort((a, b) => b.score - a.score);
	for (const edge of candidates) {
		const countA = edgeCounts.get(edge.source) ?? 0;
		const countB = edgeCounts.get(edge.target) ?? 0;
		if (countA >= kwMaxEdges && countB >= kwMaxEdges) continue;

		edges.push(edge);
		edgeCounts.set(edge.source, countA + 1);
		edgeCounts.set(edge.target, countB + 1);
	}

	return { edges, method: "keyword", truncated };
}

function extractKeywords(store: Store, title: string, content: string): Set<string> {
	// Take title + first 200 chars of content
	const text = `${title} ${content.slice(0, 200)}`;

	// Tokenize: split on whitespace, punctuation, CJK boundaries
	const tokens = text
		.toLowerCase()
		.split(/[\s,.;:!?()[\]{}"'`<>=/\\|@#$%^&*~+\-_]+/)
		.filter((t) => t.length >= 3);

	// Expand aliases for normalization
	let expanded: string[];
	try {
		expanded = expandAliases(store, tokens);
	} catch {
		expanded = tokens;
	}

	return new Set(expanded);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;

	let intersection = 0;
	const smaller = a.size <= b.size ? a : b;
	const larger = a.size <= b.size ? b : a;

	for (const item of smaller) {
		if (larger.has(item)) intersection++;
	}

	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
