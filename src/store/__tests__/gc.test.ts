import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, insertTestProject, TEST_PROJECT_ID } from "../../__tests__/test-utils.js";
import { computeUtilityScore, gc, updateUtility } from "../gc.js";
import type { Store } from "../index.js";

describe("knowledge garbage collection", () => {
	let store: Store;
	let cleanup: () => void;

	beforeEach(() => {
		const env = createTestEnv();
		store = env.store;
		cleanup = env.cleanup;
		insertTestProject(store);
	});

	afterEach(() => cleanup());

	function insertKnowledge(
		title: string,
		type = "error_resolution",
		opts: Record<string, unknown> = {},
	) {
		const now = new Date().toISOString();
		store.db
			.prepare(
				`INSERT INTO knowledge_index (project_id, type, title, content, hit_count, last_accessed, enabled, utility_score, created_at, updated_at)
				 VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				TEST_PROJECT_ID,
				type,
				title,
				(opts.hitCount as number) ?? 0,
				(opts.lastAccessed as string) ?? "",
				(opts.enabled as number) ?? 1,
				(opts.utilityScore as number) ?? 0.5,
				(opts.createdAt as string) ?? now,
				(opts.updatedAt as string) ?? now,
			);
	}

	it("dormants stale entries with 0 hits", () => {
		const old = new Date(Date.now() - 60 * 86400000).toISOString(); // 60 days ago
		insertKnowledge("stale-entry", "error_resolution", { updatedAt: old, hitCount: 0 });
		insertKnowledge("fresh-entry", "error_resolution", { hitCount: 0 }); // today

		const result = gc(store, TEST_PROJECT_ID);
		expect(result.dormanted).toBe(1);

		const stale = store.db
			.prepare("SELECT enabled FROM knowledge_index WHERE title = 'stale-entry'")
			.get() as { enabled: number };
		expect(stale.enabled).toBe(0);

		const fresh = store.db
			.prepare("SELECT enabled FROM knowledge_index WHERE title = 'fresh-entry'")
			.get() as { enabled: number };
		expect(fresh.enabled).toBe(1);
	});

	it("keeps entries with high hit count", () => {
		const old = new Date(Date.now() - 60 * 86400000).toISOString();
		insertKnowledge("popular", "error_resolution", { updatedAt: old, hitCount: 5 });

		const result = gc(store, TEST_PROJECT_ID);
		expect(result.dormanted).toBe(0);
	});

	it("deletes long-dormant entries", () => {
		const old = new Date(Date.now() - 100 * 86400000).toISOString();
		insertKnowledge("dormant-entry", "error_resolution", { updatedAt: old, enabled: 0 });

		const result = gc(store, TEST_PROJECT_ID);
		expect(result.deleted).toBe(1);

		const count = store.db
			.prepare("SELECT COUNT(*) as c FROM knowledge_index WHERE title = 'dormant-entry'")
			.get() as { c: number };
		expect(count.c).toBe(0);
	});

	it("enforces hard cap keeping highest utility entries", () => {
		const config = {
			dormantDays: { error_resolution: 45, fix_pattern: 60, convention: 365, decision: 90 },
			deleteDays: { error_resolution: 90, fix_pattern: 120, convention: 365, decision: 180 },
			hardCaps: { error_resolution: 3, fix_pattern: 300, convention: 100, decision: 200 },
		};

		for (let i = 0; i < 5; i++) {
			insertKnowledge(`entry-${i}`, "error_resolution", { utilityScore: i * 0.2 });
		}

		const result = gc(store, TEST_PROJECT_ID, config);
		expect(result.capEnforced).toBe(2); // 5 - 3 = 2 evicted

		const remaining = store.db
			.prepare(
				"SELECT title FROM knowledge_index WHERE type = 'error_resolution' AND enabled = 1 ORDER BY utility_score DESC",
			)
			.all() as Array<{ title: string }>;
		expect(remaining).toHaveLength(3);
		expect(remaining[0]!.title).toBe("entry-4"); // highest utility kept
	});

	it("gc is idempotent", () => {
		const old = new Date(Date.now() - 60 * 86400000).toISOString();
		insertKnowledge("stale", "error_resolution", { updatedAt: old, hitCount: 0 });

		gc(store, TEST_PROJECT_ID);
		const result2 = gc(store, TEST_PROJECT_ID);
		expect(result2.dormanted).toBe(0); // already dormant
	});

	it("convention type has longer dormancy", () => {
		const sixMonths = new Date(Date.now() - 200 * 86400000).toISOString();
		insertKnowledge("old-convention", "convention", { updatedAt: sixMonths, hitCount: 0 });

		const result = gc(store, TEST_PROJECT_ID);
		// 200 days < 365 days dormancy threshold for conventions
		expect(result.dormanted).toBe(0);
	});
});

describe("utility scoring", () => {
	it("computes Laplace smoothing correctly", () => {
		expect(computeUtilityScore(0, 0)).toBeCloseTo(0.5);
		expect(computeUtilityScore(1, 0)).toBeCloseTo(2 / 3);
		expect(computeUtilityScore(0, 3)).toBeCloseTo(1 / 5);
		expect(computeUtilityScore(10, 0)).toBeCloseTo(11 / 12);
	});
});
