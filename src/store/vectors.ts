import type { VectorMatch } from "../types.js";
import type { Store } from "./index.js";

const MIN_SIMILARITY = 0.6;
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
	minScore?: number,
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
			.all(source, maxCandidates) as Array<{ source_id: number; source: string; vector: Buffer | Uint8Array }>;

		let highQualityCount = 0;
		for (const row of rows) {
			const vec = deserializeFloat32(row.vector);
			if (vec.length !== queryVec.length) continue;

			const sim = cosineSimilarity(queryVec, vec);
			if (sim < (minScore ?? MIN_SIMILARITY)) continue;

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
	minScore?: number,
): VectorMatch[] {
	return vectorSearch(store, queryVec, ["knowledge"], limit, minScore);
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

export function serializeFloat32(vec: number[]): Uint8Array {
	const buf = new ArrayBuffer(vec.length * 4);
	const view = new DataView(buf);
	for (let i = 0; i < vec.length; i++) {
		view.setFloat32(i * 4, vec[i]!, true); // little-endian
	}
	return new Uint8Array(buf);
}

export function deserializeFloat32(blob: Buffer | Uint8Array): number[] {
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	const n = blob.byteLength / 4;
	const vec: number[] = new Array(n);
	for (let i = 0; i < n; i++) {
		vec[i] = view.getFloat32(i * 4, true); // little-endian
	}
	return vec;
}

export interface SimilarityPair {
	idA: number;
	idB: number;
	projectIdA?: string;
	projectIdB?: string;
	score: number;
}

/**
 * Compute pairwise cosine similarity between all stored embeddings.
 * Shared utility used by both graph edges and conflict detection.
 * @param minScore - minimum similarity to include (filters inside the loop to avoid huge arrays)
 */
export function pairwiseSimilarity(
	store: Store,
	options?: { limit?: number; minScore?: number; crossProjectOnly?: boolean; subType?: string },
): SimilarityPair[] {
	const limit = options?.limit ?? 1000;
	const minScore = options?.minScore ?? 0;
	const subTypeFilter = options?.subType ? "AND k.sub_type = ?" : "";
	const params: unknown[] = options?.subType ? [options.subType, limit] : [limit];

	const rows = store.db
		.prepare(`
    SELECT e.source_id, e.vector, k.project_id FROM embeddings e
    JOIN knowledge_index k ON k.id = e.source_id
    WHERE e.source = 'knowledge' AND k.enabled = 1 ${subTypeFilter}
    ORDER BY k.updated_at DESC
    LIMIT ?
  `)
		.all(...params) as Array<{ source_id: number; vector: Buffer; project_id: string }>;

	const docs = rows.map((r) => ({
		id: r.source_id,
		projectId: r.project_id,
		vec: deserializeFloat32(r.vector),
	}));

	const pairs: SimilarityPair[] = [];
	for (let i = 0; i < docs.length; i++) {
		for (let j = i + 1; j < docs.length; j++) {
			// Skip same-project pairs if crossProjectOnly
			if (options?.crossProjectOnly && docs[i]!.projectId === docs[j]!.projectId) continue;
			if (docs[i]!.vec.length !== docs[j]!.vec.length) continue;
			const sim = cosineSimilarity(docs[i]!.vec, docs[j]!.vec);
			if (sim >= minScore) {
				pairs.push({
					idA: docs[i]!.id,
					idB: docs[j]!.id,
					projectIdA: docs[i]!.projectId,
					projectIdB: docs[j]!.projectId,
					score: sim,
				});
			}
		}
	}

	return pairs;
}

export interface SimilarSpecResult {
	id: number;
	slug: string;
	fileName: string;
	projectId: string;
	projectName: string;
	similarity: number;
}

/**
 * Find specs similar to a given spec by vector similarity.
 * Falls back to FTS5 keyword match if no embedder.
 */
export function findSimilarSpecs(
	store: Store,
	specId: number,
	opts?: { limit?: number; minSimilarity?: number },
): SimilarSpecResult[] {
	const limit = opts?.limit ?? 5;
	const minSim = opts?.minSimilarity ?? 0.60;

	// Get the target spec's embedding
	const targetRow = store.db
		.prepare("SELECT vector FROM embeddings WHERE source = 'spec' AND source_id = ?")
		.get(specId) as { vector: Buffer | Uint8Array } | undefined;

	if (!targetRow) {
		// FTS5 fallback: keyword match on spec content
		const specRow = store.db
			.prepare("SELECT slug, content FROM spec_index WHERE id = ?")
			.get(specId) as { slug: string; content: string } | undefined;
		if (!specRow) return [];

		const words = specRow.content.split(/\s+/).slice(0, 10)
			.map((w) => w.replace(/["*^{}]/g, "")).filter(Boolean)
			.map((w) => `"${w}"`).join(" OR ");
		if (!words) return [];
		const ftsRows = store.db
			.prepare(`
				SELECT s.id, s.slug, s.file_name, s.project_id, p.name as project_name,
					bm25(spec_fts) as score
				FROM spec_fts f
				JOIN spec_index s ON s.id = f.rowid
				JOIN projects p ON p.id = s.project_id
				WHERE spec_fts MATCH ? AND s.id != ?
				ORDER BY score LIMIT ?
			`)
			.all(words, specId, limit) as Array<{
				id: number; slug: string; file_name: string;
				project_id: string; project_name: string; score: number;
			}>;
		return ftsRows.map((r) => ({
			id: r.id,
			slug: r.slug,
			fileName: r.file_name,
			projectId: r.project_id,
			projectName: r.project_name,
			similarity: Math.abs(r.score), // BM25 returns negative scores
		}));
	}

	const targetVec = deserializeFloat32(targetRow.vector);

	// Get all other spec embeddings
	const rows = store.db
		.prepare(`
			SELECT e.source_id, e.vector, s.slug, s.file_name, s.project_id, p.name as project_name
			FROM embeddings e
			JOIN spec_index s ON s.id = e.source_id
			JOIN projects p ON p.id = s.project_id
			WHERE e.source = 'spec' AND e.source_id != ?
		LIMIT 1000
		`)
		.all(specId) as Array<{
			source_id: number; vector: Buffer; slug: string;
			file_name: string; project_id: string; project_name: string;
		}>;

	const results: SimilarSpecResult[] = [];
	for (const r of rows) {
		const vec = deserializeFloat32(r.vector);
		if (vec.length !== targetVec.length) continue;
		const sim = cosineSimilarity(targetVec, vec);
		if (sim >= minSim) {
			results.push({
				id: r.source_id,
				slug: r.slug,
				fileName: r.file_name,
				projectId: r.project_id,
				projectName: r.project_name,
				similarity: Math.round(sim * 1000) / 1000,
			});
		}
	}

	results.sort((a, b) => b.similarity - a.similarity);
	return results.slice(0, limit);
}
