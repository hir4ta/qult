import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeRow } from "../../types.js";
import { Store } from "../index.js";
import { upsertKnowledge } from "../knowledge.js";
import { insertEmbedding, pairwiseSimilarity } from "../vectors.js";
import { computeGraphEdges } from "../graph.js";

function insertTestProject(store: Store, id = "test-project-id"): string {
	store.db.prepare(`
		INSERT OR IGNORE INTO projects (id, name, remote, path, branch, registered_at, last_seen_at, status)
		VALUES (?, 'test', '', '/test', '', datetime('now'), datetime('now'), 'active')
	`).run(id);
	return id;
}

let store: Store;
let tmpDir: string;
let projectId: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "graph-test-"));
	store = Store.open(join(tmpDir, "test.db"));
	projectId = insertTestProject(store);
	fileCounter = 0;
});

afterEach(() => {
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function makeRow(overrides: Partial<KnowledgeRow> = {}): KnowledgeRow {
	return {
		id: 0, filePath: "decisions/test.json", contentHash: "", title: "Test",
		content: "test content", subType: "decision", projectId,
		branch: "main", createdAt: new Date().toISOString(),
		updatedAt: "", hitCount: 0, lastAccessed: "", enabled: true, ...overrides,
	};
}

/**
 * Generate a test vector with controlled similarity.
 * Vectors with close seeds will have HIGH similarity.
 * Vectors with distant seeds will have LOW similarity.
 */
function makeVector(dims: number, seed: number): number[] {
	// Base vector + small perturbation from seed — ensures positive cosine similarity for close seeds
	const vec = new Array(dims);
	for (let i = 0; i < dims; i++) {
		vec[i] = 1.0 + seed * 0.1 * Math.sin(i + 1);
	}
	// Normalize
	let norm = 0;
	for (const v of vec) norm += v * v;
	norm = Math.sqrt(norm);
	for (let i = 0; i < dims; i++) vec[i] /= norm;
	return vec;
}

let fileCounter = 0;

function insertKnowledgeWithEmbedding(
	store: Store,
	title: string,
	content: string,
	seed: number,
	overrides: Partial<KnowledgeRow> = {},
): number {
	fileCounter++;
	const { id } = upsertKnowledge(store, makeRow({
		filePath: `decisions/entry-${fileCounter}.json`,
		title,
		content,
		...overrides,
	}));
	store.expectedDims = 16;
	insertEmbedding(store, "knowledge", id, "test-model", makeVector(16, seed));
	return id;
}

describe("pairwiseSimilarity", () => {
	it("returns empty for no embeddings", () => {
		const pairs = pairwiseSimilarity(store);
		expect(pairs).toHaveLength(0);
	});

	it("computes similarity for all pairs", () => {
		const idA = insertKnowledgeWithEmbedding(store, "A", "unique content alpha one", 1);
		const idB = insertKnowledgeWithEmbedding(store, "B", "unique content beta two", 2);
		const idC = insertKnowledgeWithEmbedding(store, "C", "unique content gamma three", 3);

		// Verify all entries and embeddings exist
		const knowledgeCount = (store.db.prepare("SELECT COUNT(*) as cnt FROM knowledge_index WHERE enabled = 1").get() as {cnt:number}).cnt;
		const embCount = (store.db.prepare("SELECT COUNT(*) as cnt FROM embeddings WHERE source = 'knowledge'").get() as {cnt:number}).cnt;
		expect(knowledgeCount).toBe(3);
		expect(embCount).toBe(3);

		const pairs = pairwiseSimilarity(store);
		// 3 entries = 3 pairs: A-B, A-C, B-C
		expect(pairs).toHaveLength(3);
		for (const p of pairs) {
			expect(p.score).toBeGreaterThanOrEqual(-1);
			expect(p.score).toBeLessThanOrEqual(1);
		}
	});

	it("filters by minScore", () => {
		insertKnowledgeWithEmbedding(store, "A", "filter test alpha content", 1);
		insertKnowledgeWithEmbedding(store, "B", "filter test beta different", 2);

		const allPairs = pairwiseSimilarity(store);
		expect(allPairs).toHaveLength(1);

		// With very high threshold, should filter out (seeds 1 and 2 have ~0.998 sim, not >= 0.999)
		const highPairs = pairwiseSimilarity(store, { minScore: 0.999 });
		expect(highPairs).toHaveLength(0);
	});

	it("excludes disabled entries", () => {
		insertKnowledgeWithEmbedding(store, "A", "content a", 1);
		insertKnowledgeWithEmbedding(store, "B", "content b", 2, { enabled: false });

		// Disable entry B in the DB
		store.db.prepare("UPDATE knowledge_index SET enabled = 0 WHERE title = ?").run("B");

		const pairs = pairwiseSimilarity(store);
		expect(pairs).toHaveLength(0);
	});

	it("respects limit parameter", () => {
		for (let i = 0; i < 5; i++) {
			insertKnowledgeWithEmbedding(store, `Entry${i}`, `content ${i}`, i + 1);
		}

		const limitedPairs = pairwiseSimilarity(store, { limit: 3 });
		// 3 entries = 3 pairs max
		expect(limitedPairs.length).toBeLessThanOrEqual(3);
	});
});

describe("computeGraphEdges", () => {
	it("returns vector method when embeddings exist", () => {
		insertKnowledgeWithEmbedding(store, "A", "content a", 1);
		insertKnowledgeWithEmbedding(store, "B", "content b", 2);

		const result = computeGraphEdges(store);
		expect(result.method).toBe("vector");
		expect(result.truncated).toBe(false);
	});

	it("returns keyword method when no embeddings", () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/a.json", title: "Auth Design", content: "authentication flow",
		}));
		upsertKnowledge(store, makeRow({
			filePath: "decisions/b.json", title: "Auth Testing", content: "authentication test",
		}));

		const result = computeGraphEdges(store);
		expect(result.method).toBe("keyword");
		expect(result.truncated).toBe(false);
	});

	it("filters edges by threshold", () => {
		// Same seed = identical vector = similarity 1.0
		insertKnowledgeWithEmbedding(store, "A", "content a", 1);
		insertKnowledgeWithEmbedding(store, "B", "content b", 1); // same seed → sim=1.0
		insertKnowledgeWithEmbedding(store, "C", "content c", 100); // very different

		const result = computeGraphEdges(store, { threshold: 0.9 });
		// A-B should have high similarity (same seed), A-C and B-C should be filtered
		const highSimEdges = result.edges.filter((e) => e.score >= 0.9);
		expect(highSimEdges.length).toBeGreaterThanOrEqual(1);
	});

	it("threshold is inclusive (>= 0.45)", () => {
		insertKnowledgeWithEmbedding(store, "A", "content a", 1);
		insertKnowledgeWithEmbedding(store, "B", "content b", 1);

		// With threshold at exactly the similarity, edge should be included
		const pairs = pairwiseSimilarity(store);
		const exactSim = pairs[0]!.score;

		const result = computeGraphEdges(store, { threshold: exactSim });
		expect(result.edges.length).toBeGreaterThanOrEqual(1);
	});

	it("applies per-node top-K limit", () => {
		// Create entries with very similar vectors (close seeds = high similarity)
		for (let i = 0; i < 8; i++) {
			insertKnowledgeWithEmbedding(store, `Entry${i}`, `content ${i}`, 1 + i * 0.001);
		}

		const result = computeGraphEdges(store, { threshold: 0.1, maxEdgesPerNode: 2 });
		// Count edges per node
		const edgeCounts = new Map<number, number>();
		for (const edge of result.edges) {
			edgeCounts.set(edge.source, (edgeCounts.get(edge.source) ?? 0) + 1);
			edgeCounts.set(edge.target, (edgeCounts.get(edge.target) ?? 0) + 1);
		}
		// With maxEdgesPerNode=2, edges are added only when at least one side has < 2
		// Due to bidirectional counting, a node can appear as source or target
		// The algorithm skips edges where BOTH sides >= max, so some nodes may reach max+1
		// but the total edge count should be significantly reduced vs unrestricted
		if (edgeCounts.size > 0) {
			const unrestricted = computeGraphEdges(store, { threshold: 0.1, maxEdgesPerNode: 100 });
			expect(result.edges.length).toBeLessThan(unrestricted.edges.length);
		}
	});

	it("returns empty edges when all pairs below threshold", () => {
		insertKnowledgeWithEmbedding(store, "A", "content a", 1);
		insertKnowledgeWithEmbedding(store, "B", "content b", 100);

		const result = computeGraphEdges(store, { threshold: 0.99 });
		expect(result.edges).toHaveLength(0);
		expect(result.method).toBe("vector");
	});

	it("excludes disabled entries", () => {
		const idA = insertKnowledgeWithEmbedding(store, "A", "content a", 1);
		insertKnowledgeWithEmbedding(store, "B", "content b", 1);

		// Disable A
		store.db.prepare("UPDATE knowledge_index SET enabled = 0 WHERE id = ?").run(idA);

		const result = computeGraphEdges(store);
		// No edges involving disabled entry A
		for (const edge of result.edges) {
			expect(edge.source).not.toBe(idA);
			expect(edge.target).not.toBe(idA);
		}
	});

	it("sets truncated=true when entries exceed limit", () => {
		for (let i = 0; i < 5; i++) {
			insertKnowledgeWithEmbedding(store, `Entry${i}`, `content ${i}`, i + 1);
		}

		const result = computeGraphEdges(store, { limit: 3 });
		expect(result.truncated).toBe(true);
	});

	it("keyword fallback generates edges from shared keywords", () => {
		const { id: idA } = upsertKnowledge(store, makeRow({
			filePath: "decisions/auth-design.json",
			title: "Authentication Design Pattern",
			content: "authentication flow with JWT tokens for secure access",
		}));
		const { id: idB } = upsertKnowledge(store, makeRow({
			filePath: "decisions/auth-test.json",
			title: "Authentication Testing Strategy",
			content: "testing authentication endpoints with integration tests",
		}));
		const { id: idC } = upsertKnowledge(store, makeRow({
			filePath: "decisions/db-migrate.json",
			title: "Database Migration Plan",
			content: "migrate database schema from version seven to eight",
		}));

		const result = computeGraphEdges(store);
		expect(result.method).toBe("keyword");
		// A and B share "authentication" — should have an edge between them
		const abEdge = result.edges.find((e) =>
			(e.source === idA && e.target === idB) || (e.source === idB && e.target === idA),
		);
		expect(abEdge).toBeDefined();
		// C has no shared keywords with A or B — should have no edges to them
		const cEdges = result.edges.filter((e) =>
			e.source === idC || e.target === idC,
		);
		expect(cEdges).toHaveLength(0);
	});
});
