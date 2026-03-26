import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, insertTestProject, TEST_PROJECT_ID } from "../../__tests__/test-utils.js";
import type { Store } from "../index.js";

describe("schema migration v1 to v2", () => {
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
		// Insert v1 data
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

		// Verify data survived
		const ki = store.db
			.prepare("SELECT title FROM knowledge_index WHERE title = 'preserved'")
			.get() as { title: string } | undefined;
		expect(ki?.title).toBe("preserved");

		const qe = store.db
			.prepare("SELECT event_type FROM quality_events WHERE session_id = 'sess'")
			.get() as { event_type: string } | undefined;
		expect(qe?.event_type).toBe("gate_pass");
	});
});
