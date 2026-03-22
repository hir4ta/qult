import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../store/index.js";
import { upsertKnowledge } from "../../store/knowledge.js";
import { insertTestProject, makeRow } from "../../__tests__/test-utils.js";
import { trackHitCounts, type ScoredDoc } from "../helpers.js";
import { recencyFactor } from "../helpers.js";
import { subTypeBoost } from "../../store/fts.js";

let tmpDir: string;
let store: Store;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "hit-threshold-test-"));
	store = Store.open(join(tmpDir, "test.db"));
	insertTestProject(store);
});

afterEach(() => {
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function getHitCount(id: number): number {
	const row = store.db.prepare("SELECT hit_count FROM knowledge_index WHERE id = ?").get(id) as { hit_count: number } | undefined;
	return row?.hit_count ?? 0;
}

function makeScoredDoc(id: number, score: number): ScoredDoc {
	return {
		doc: { ...makeRow(), id },
		score,
		matchReason: "test",
	};
}

describe("hit count threshold (MIN_HIT_SCORE = 0.6)", () => {
	let docId: number;

	beforeEach(() => {
		const result = upsertKnowledge(store, makeRow({ title: "Test entry" }));
		docId = result.id;
		expect(getHitCount(docId)).toBe(0);
	});

	it("does NOT increment for score below 0.6", () => {
		trackHitCounts(store, [makeScoredDoc(docId, 0.59)]);
		expect(getHitCount(docId)).toBe(0);
	});

	it("does NOT increment for score 0.0", () => {
		trackHitCounts(store, [makeScoredDoc(docId, 0)]);
		expect(getHitCount(docId)).toBe(0);
	});

	it("DOES increment for score exactly 0.6", () => {
		trackHitCounts(store, [makeScoredDoc(docId, 0.6)]);
		expect(getHitCount(docId)).toBe(1);
	});

	it("DOES increment for score 1.0", () => {
		trackHitCounts(store, [makeScoredDoc(docId, 1.0)]);
		expect(getHitCount(docId)).toBe(1);
	});

	it("DOES increment for high score 1.5 (boosted decision)", () => {
		trackHitCounts(store, [makeScoredDoc(docId, 1.5)]);
		expect(getHitCount(docId)).toBe(1);
	});

	it("mixed scores: only counts qualifying entries", () => {
		const id2 = upsertKnowledge(store, makeRow({ title: "Second", filePath: "d/second.json" })).id;
		const id3 = upsertKnowledge(store, makeRow({ title: "Third", filePath: "d/third.json" })).id;

		trackHitCounts(store, [
			makeScoredDoc(docId, 0.95), // qualifies
			makeScoredDoc(id2, 0.42),   // does NOT qualify
			makeScoredDoc(id3, 0.61),   // qualifies
		]);

		expect(getHitCount(docId)).toBe(1);
		expect(getHitCount(id2)).toBe(0);
		expect(getHitCount(id3)).toBe(1);
	});

	it("empty array does nothing", () => {
		trackHitCounts(store, []);
		expect(getHitCount(docId)).toBe(0);
	});

	it("all below threshold does nothing", () => {
		trackHitCounts(store, [
			makeScoredDoc(docId, 0.1),
			makeScoredDoc(docId, 0.3),
			makeScoredDoc(docId, 0.59),
		]);
		expect(getHitCount(docId)).toBe(0);
	});
});

describe("score distribution by position and type", () => {
	// Score = posScore × recency × subTypeBoost
	// posScore = 1/(i+1): pos0=1.0, pos1=0.5, pos2=0.33, pos3=0.25, pos4=0.20

	const now = new Date();
	const fresh = now.toISOString();

	it("position 1 (i=0): all types pass threshold", () => {
		const posScore = 1.0;
		const recency = recencyFactor(fresh, "decision", now); // ~1.0
		expect(posScore * recency * subTypeBoost("decision")).toBeGreaterThanOrEqual(0.6); // 1.5
		expect(posScore * recency * subTypeBoost("pattern")).toBeGreaterThanOrEqual(0.6);  // 1.3
		expect(posScore * recency * subTypeBoost("rule")).toBeGreaterThanOrEqual(0.6);     // 2.0
	});

	it("position 2 (i=1): all types still pass (boosted)", () => {
		const posScore = 0.5;
		expect(posScore * 1.0 * subTypeBoost("decision")).toBeCloseTo(0.75, 1); // pass
		expect(posScore * 1.0 * subTypeBoost("pattern")).toBeCloseTo(0.65, 1);  // pass
		expect(posScore * 1.0 * subTypeBoost("rule")).toBeCloseTo(1.0, 1);      // pass
	});

	it("position 3 (i=2): pattern drops below 0.6", () => {
		const posScore = 1 / 3; // 0.333
		expect(posScore * 1.0 * subTypeBoost("decision")).toBeCloseTo(0.50, 1); // FAIL
		expect(posScore * 1.0 * subTypeBoost("pattern")).toBeCloseTo(0.43, 1);  // FAIL
		expect(posScore * 1.0 * subTypeBoost("rule")).toBeCloseTo(0.67, 1);     // pass (rules are extra important)
	});

	it("position 4 (i=3): only rules pass", () => {
		const posScore = 0.25;
		expect(posScore * 1.0 * subTypeBoost("decision")).toBeCloseTo(0.375, 1); // FAIL
		expect(posScore * 1.0 * subTypeBoost("rule")).toBeCloseTo(0.50, 1);      // FAIL too
	});

	it("position 5+ (i=4): nothing passes", () => {
		const posScore = 0.2;
		expect(posScore * 1.0 * subTypeBoost("rule")).toBeCloseTo(0.40, 1); // FAIL
	});
});

describe("recency impact on threshold", () => {
	const now = new Date();

	it("fresh entry (today): no recency penalty", () => {
		const rf = recencyFactor(now.toISOString(), "decision", now);
		expect(rf).toBeCloseTo(1.0, 1);
	});

	it("30-day old decision (half-life=90d): mild decay", () => {
		const old = new Date(now.getTime() - 30 * 86400000);
		const rf = recencyFactor(old.toISOString(), "decision", now);
		expect(rf).toBeGreaterThan(0.75); // ~0.79, still significant

		// Position 1 decision with 30-day decay: 1.0 × 0.79 × 1.5 = 1.19 — passes
		expect(1.0 * rf * subTypeBoost("decision")).toBeGreaterThanOrEqual(0.6);
	});

	it("90-day old pattern (half-life=90d): at half-life", () => {
		const old = new Date(now.getTime() - 90 * 86400000);
		const rf = recencyFactor(old.toISOString(), "pattern", now);
		expect(rf).toBeCloseTo(0.5, 1); // at half-life

		// Position 1 with half-life decay: 1.0 × 0.5 × 1.3 = 0.65 — barely passes
		expect(1.0 * rf * subTypeBoost("pattern")).toBeCloseTo(0.65, 1);
		// Position 2 with half-life decay: 0.5 × 0.5 × 1.3 = 0.325 — FAILS
		expect(0.5 * rf * subTypeBoost("pattern")).toBeLessThan(0.6);
	});

	it("180-day old entry: hits recency floor (0.5)", () => {
		const veryOld = new Date(now.getTime() - 180 * 86400000);
		const rf = recencyFactor(veryOld.toISOString(), "decision", now);
		expect(rf).toBe(0.5); // floor

		// Position 1: 1.0 × 0.5 × 1.5 = 0.75 — still passes
		expect(1.0 * rf * subTypeBoost("decision")).toBeCloseTo(0.75, 1);
		// Position 2: 0.5 × 0.5 × 1.5 = 0.375 — FAILS
		expect(0.5 * rf * subTypeBoost("decision")).toBeLessThan(0.6);
	});
});

describe("threshold 0.6 summary — what gets counted", () => {
	// This test documents the effective behavior with 0.6 threshold.
	// Fresh entries (recency ~1.0):
	//   Position 1: decision(1.50) ✓, pattern(1.30) ✓, rule(2.00) ✓
	//   Position 2: decision(0.75) ✓, pattern(0.65) ✓, rule(1.00) ✓
	//   Position 3: decision(0.50) ✗, pattern(0.43) ✗, rule(0.67) ✓
	//   Position 4+: all ✗
	//
	// Half-life entries (recency ~0.5):
	//   Position 1: decision(0.75) ✓, pattern(0.65) ✓, rule(1.00) ✓
	//   Position 2: decision(0.38) ✗, pattern(0.33) ✗, rule(0.50) ✗
	//
	// Very old entries (recency floor 0.5):
	//   Same as half-life

	it("at most top-2 fresh entries get counted (top-3 for rules)", () => {
		// For 7 knowledge entries, a search returning all 7 sorted by relevance
		// would only count hits for the top 2 (or top 3 if rules)
		// This is the correct behavior — only truly relevant matches accumulate hits
		const freshDecisionScores = Array.from({ length: 7 }, (_, i) => {
			const posScore = 1 / (i + 1);
			return Math.round(posScore * 1.0 * subTypeBoost("decision") * 100) / 100;
		});

		const qualifying = freshDecisionScores.filter((s) => s >= 0.6);
		expect(qualifying.length).toBe(2); // only positions 1 and 2
	});

	it("stale entries are even more restricted", () => {
		const stalePatternScores = Array.from({ length: 7 }, (_, i) => {
			const posScore = 1 / (i + 1);
			return Math.round(posScore * 0.5 * subTypeBoost("pattern") * 100) / 100;
		});

		const qualifying = stalePatternScores.filter((s) => s >= 0.6);
		expect(qualifying.length).toBe(1); // only position 1
	});
});
