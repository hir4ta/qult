import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, insertTestProject, TEST_PROJECT_ID } from "../../__tests__/test-utils.js";
import type { Store } from "../index.js";

describe("schema v3", () => {
	let store: Store;
	let cleanup: () => void;

	beforeEach(() => {
		const env = createTestEnv();
		store = env.store;
		cleanup = env.cleanup;
	});

	afterEach(() => cleanup());

	it("allows fix_pattern knowledge type", () => {
		insertTestProject(store);
		const result = store.db
			.prepare(
				"INSERT INTO knowledge_index (project_id, type, title, content, created_at, updated_at) VALUES (?, 'fix_pattern', 'test', '{}', datetime('now'), datetime('now'))",
			)
			.run(TEST_PROJECT_ID);
		expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);
	});

	it("allows decision knowledge type", () => {
		insertTestProject(store);
		const result = store.db
			.prepare(
				"INSERT INTO knowledge_index (project_id, type, title, content, created_at, updated_at) VALUES (?, 'decision', 'test', '{}', datetime('now'), datetime('now'))",
			)
			.run(TEST_PROJECT_ID);
		expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);
	});

	it("rejects exemplar knowledge type", () => {
		insertTestProject(store);
		expect(() =>
			store.db
				.prepare(
					"INSERT INTO knowledge_index (project_id, type, title, content, created_at, updated_at) VALUES (?, 'exemplar', 'test', '{}', datetime('now'), datetime('now'))",
				)
				.run(TEST_PROJECT_ID),
		).toThrow();
	});

	it("allows plan_created quality event type", () => {
		insertTestProject(store);
		const result = store.db
			.prepare(
				"INSERT INTO quality_events (project_id, session_id, event_type, data) VALUES (?, 'sess', 'plan_created', '{}')",
			)
			.run(TEST_PROJECT_ID);
		expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);
	});

	it("allows knowledge_saved quality event type", () => {
		insertTestProject(store);
		const result = store.db
			.prepare(
				"INSERT INTO quality_events (project_id, session_id, event_type, data) VALUES (?, 'sess', 'knowledge_saved', '{}')",
			)
			.run(TEST_PROJECT_ID);
		expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);
	});

	it("preserves existing data after migration", () => {
		insertTestProject(store);
		store.db
			.prepare(
				"INSERT INTO knowledge_index (project_id, type, title, content, created_at, updated_at) VALUES (?, 'error_resolution', 'preserved', '{\"test\":true}', datetime('now'), datetime('now'))",
			)
			.run(TEST_PROJECT_ID);
		store.db
			.prepare(
				"INSERT INTO quality_events (project_id, session_id, event_type, data) VALUES (?, 'sess', 'gate_pass', '{}')",
			)
			.run(TEST_PROJECT_ID);

		const ki = store.db
			.prepare("SELECT title FROM knowledge_index WHERE title = 'preserved'")
			.get() as { title: string } | undefined;
		expect(ki?.title).toBe("preserved");

		const qe = store.db
			.prepare("SELECT event_type FROM quality_events WHERE session_id = 'sess'")
			.get() as { event_type: string } | undefined;
		expect(qe?.event_type).toBe("gate_pass");
	});

	it("has utility tracking columns in knowledge_index", () => {
		insertTestProject(store);
		store.db
			.prepare(
				"INSERT INTO knowledge_index (project_id, type, title, content, created_at, updated_at, source) VALUES (?, 'error_resolution', 'util-test', '{}', datetime('now'), datetime('now'), 'auto')",
			)
			.run(TEST_PROJECT_ID);

		const row = store.db
			.prepare(
				"SELECT success_count, failure_count, utility_score, confidence, source FROM knowledge_index WHERE title = 'util-test'",
			)
			.get() as {
			success_count: number;
			failure_count: number;
			utility_score: number;
			confidence: number;
			source: string;
		};
		expect(row.success_count).toBe(0);
		expect(row.failure_count).toBe(0);
		expect(row.utility_score).toBe(0.5);
		expect(row.confidence).toBe(0.5);
		expect(row.source).toBe("auto");
	});

	it("allows new v3 quality event types", () => {
		insertTestProject(store);
		const newTypes = [
			"security_warn",
			"security_pass",
			"pace_warn",
			"pace_deny",
			"layer_warn",
			"layer_pass",
			"budget_trim",
			"plan_drift",
			"reflection_depth",
			"duplicate_warn",
		];
		for (const eventType of newTypes) {
			const result = store.db
				.prepare(
					"INSERT INTO quality_events (project_id, session_id, event_type, data) VALUES (?, 'sess', ?, '{}')",
				)
				.run(TEST_PROJECT_ID, eventType);
			expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);
		}
	});
});
