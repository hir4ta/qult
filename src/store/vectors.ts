import type { VectorMatch } from "../types.js";
import type { Store } from "./index.js";

const MIN_SIMILARITY = 0.3;
const DEFAULT_MAX_VECTOR_CANDIDATES = 10_000;
const EARLY_STOP_THRESHOLD = 0.7;

function envIntOrDefault(key: string, fallback: number): number {
	const v = process.env[key];
	if (v) {
		const n = parseInt(v, 10);
		if (!Number.isNaN(n) && n > 0) return n;
	}
	return fallback;
}

export function insertEmbedding(
	store: Store,
	source: string,
	sourceId: number,
	model: string,
	vector: number[],
): void {
	if (store.expectedDims > 0 && vector.length !== store.expectedDims) {
		throw new Error(
			`store: insert embedding: dimension mismatch: got ${vector.length}, expected ${store.expectedDims}`,
		);
	}
	const blob = serializeFloat32(vector);
	store.db
		.prepare(`
    INSERT OR REPLACE INTO embeddings (source, source_id, model, dims, vector)
    VALUES (?, ?, ?, ?, ?)
  `)
		.run(source, sourceId, model, vector.length, blob);
}

export function cleanOrphanedEmbeddings(store: Store): number {
	const r1 = store.db
		.prepare(`
    DELETE FROM embeddings WHERE source = 'knowledge'
    AND source_id NOT IN (SELECT id FROM knowledge_index)
  `)
		.run();
	const r2 = store.db
		.prepare(`
    DELETE FROM embeddings WHERE source = 'spec'
    AND source_id NOT IN (SELECT id FROM spec_index)
  `)
		.run();
	return r1.changes + r2.changes;
}

export type VectorSource = "knowledge" | "spec";

export function vectorSearch(
	store: Store,
	queryVec: number[],
	sources: VectorSource[],
	limit: number,
): VectorMatch[] {
	if (!queryVec || queryVec.length === 0) return [];
	if (limit <= 0) limit = 10;
	if (sources.length === 0) return [];

	const maxCandidates = envIntOrDefault(
		"ALFRED_MAX_VECTOR_CANDIDATES",
		DEFAULT_MAX_VECTOR_CANDIDATES,
	);
	const earlyStopCount = Math.max(limit * 3, 50);

	const allCandidates: VectorMatch[] = [];

	for (const source of sources) {
		const ALLOWED_TABLES: Record<string, string> = { knowledge: "knowledge_index", spec: "spec_index" };
		const joinTable = ALLOWED_TABLES[source];
		if (!joinTable) throw new Error(`vectorSearch: invalid source "${source}"`);
		const filter = source === "knowledge" ? "AND t.enabled = 1" : "";

		const rows = store.db
			.prepare(`
      SELECT e.source_id, e.source, e.vector FROM embeddings e
      JOIN ${joinTable} t ON t.id = e.source_id
      WHERE e.source = ? ${filter}
      LIMIT ?
    `)
			.all(source, maxCandidates) as Array<{ source_id: number; source: string; vector: Buffer }>;

		let highQualityCount = 0;
		for (const row of rows) {
			const vec = deserializeFloat32(row.vector);
			if (vec.length !== queryVec.length) continue;

			const sim = cosineSimilarity(queryVec, vec);
			if (sim < MIN_SIMILARITY) continue;

			allCandidates.push({ sourceId: row.source_id, score: sim, source: row.source as VectorSource });
			if (sim >= EARLY_STOP_THRESHOLD) {
				highQualityCount++;
				if (highQualityCount >= earlyStopCount) break;
			}
		}
	}

	allCandidates.sort((a, b) => b.score - a.score);
	return allCandidates.slice(0, limit);
}

/** Backward-compatible wrapper for knowledge-only vector search. */
export function vectorSearchKnowledge(
	store: Store,
	queryVec: number[],
	limit: number,
): VectorMatch[] {
	return vectorSearch(store, queryVec, ["knowledge"], limit);
}

export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0,
		normA = 0,
		normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		normA += a[i]! * a[i]!;
		normB += b[i]! * b[i]!;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function serializeFloat32(vec: number[]): Buffer {
	const buf = Buffer.allocUnsafe(vec.length * 4);
	for (let i = 0; i < vec.length; i++) {
		buf.writeFloatLE(vec[i]!, i * 4);
	}
	return buf;
}

export function deserializeFloat32(blob: Buffer): number[] {
	const n = blob.length / 4;
	const vec: number[] = new Array(n);
	for (let i = 0; i < n; i++) {
		vec[i] = blob.readFloatLE(i * 4);
	}
	return vec;
}

export interface SimilarityPair {
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
    ORDER BY k.hit_count DESC
    LIMIT ?
  `)
		.all(limit) as Array<{ source_id: number; vector: Buffer }>;

	const docs = rows.map((r) => ({
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
