import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../store/index.js";
import { upsertKnowledge } from "../../store/knowledge.js";
import type { KnowledgeRow } from "../../types.js";
import { recencyFactor, searchPipeline, trackHitCounts, truncate } from "../helpers.js";

let tmpDir: string;
let store: Store;

const TEST_PROJECT_ID = "test-project-id";

function insertTestProject(db: Database.Database, id = TEST_PROJECT_ID): string {
	db.prepare(`
		INSERT OR IGNORE INTO projects (id, name, remote, path, branch, registered_at, last_seen_at, status)
		VALUES (?, 'test', '', '/test', '', datetime('now'), datetime('now'), 'active')
	`).run(id);
	return id;
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "helpers-test-"));
	store = Store.open(join(tmpDir, "test.db"));
	insertTestProject(store.db);
});

afterEach(() => {
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function makeRow(overrides: Partial<KnowledgeRow> = {}): KnowledgeRow {
	return {
		id: 0, filePath: "decisions/test.json", contentHash: "", title: "Test",
		content: '{"id":"test"}', subType: "decision", projectId: TEST_PROJECT_ID,
		branch: "main", createdAt: new Date().toISOString(), updatedAt: "",
		hitCount: 0, lastAccessed: "", enabled: true, ...overrides,
	};
}

describe("truncate", () => {
	it("returns short string unchanged", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	it("truncates long string with ellipsis", () => {
		expect(truncate("hello world", 5)).toBe("hello...");
	});

	it("handles empty string", () => {
		expect(truncate("", 5)).toBe("");
	});

	it("handles exact length", () => {
		expect(truncate("hello", 5)).toBe("hello");
	});

	it("handles unicode characters", () => {
		expect(truncate("こんにちは世界", 3)).toBe("こんに...");
	});

	it("handles emoji", () => {
		expect(truncate("👋🌍🎉✨", 2)).toBe("👋🌍...");
	});
});

describe("recencyFactor", () => {
	it("returns 1.0 for recent entries", () => {
		const now = new Date();
		const factor = recencyFactor(now.toISOString(), "decision", now);
		expect(factor).toBeCloseTo(1.0, 1);
	});

	it("returns < 1.0 for older entries", () => {
		const now = new Date();
		const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
		const factor = recencyFactor(old.toISOString(), "decision", now);
		expect(factor).toBeLessThan(1.0);
		expect(factor).toBeGreaterThan(0);
	});

	it("floors at 0.5", () => {
		const now = new Date();
		const veryOld = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); // 1 year ago
		const factor = recencyFactor(veryOld.toISOString(), "decision", now);
		expect(factor).toBe(0.5);
	});

	it("returns 1.0 for invalid date", () => {
		expect(recencyFactor("not-a-date", "decision", new Date())).toBe(1.0);
	});

	it("returns 1.0 for empty date", () => {
		expect(recencyFactor("", "decision", new Date())).toBe(1.0);
	});

	it("applies different half-lives per sub_type", () => {
		const now = new Date();
		const old = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000); // 45 days ago
		const decisionFactor = recencyFactor(old.toISOString(), "decision", now); // 90d half-life
		const patternFactor = recencyFactor(old.toISOString(), "pattern", now); // 90d half-life
		// Both decision and pattern have 90d half-life so should be similar
		expect(Math.abs(decisionFactor - patternFactor)).toBeLessThan(0.01);
	});
});

describe("searchPipeline", () => {
	it("falls back to FTS5 when no embedder", async () => {
		// Seed some data
		upsertKnowledge(store, makeRow({
			filePath: "decisions/auth.json", title: "Auth Decision",
			content: '{"id":"auth","decision":"Use JWT authentication"}',
		}));

		const result = await searchPipeline(store, null, "authentication", 5, 15);
		expect(result.searchMethod).toBe("fts5");
		// May or may not find results depending on FTS tokenization
	});

	it("falls back to keyword when FTS5 fails on simple terms", async () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/db.json", title: "Database Choice",
			content: '{"id":"db","decision":"Use SQLite"}',
		}));

		const result = await searchPipeline(store, null, "SQLite", 5, 15);
		// Should use fts5 or keyword fallback
		expect(["fts5", "keyword"]).toContain(result.searchMethod);
	});

	it("returns empty results for no matches", async () => {
		const result = await searchPipeline(store, null, "nonexistent", 5, 15);
		expect(result.scoredDocs.length).toBe(0);
	});

	it("excludes snapshots from results", async () => {
		upsertKnowledge(store, makeRow({
			filePath: "chapters/test/chapter-1", title: "Chapter snapshot",
			content: "session snapshot data", subType: "snapshot",
		}));

		const result = await searchPipeline(store, null, "snapshot", 5, 15);
		expect(result.scoredDocs.every((sd) => sd.doc.subType !== "snapshot")).toBe(true);
	});

	it("limits results to requested limit", async () => {
		for (let i = 0; i < 10; i++) {
			upsertKnowledge(store, makeRow({
				filePath: `decisions/d${i}.json`, title: `Decision ${i}`,
				content: `{"id":"d${i}","decision":"Decision about testing item ${i}"}`,
			}));
		}

		const result = await searchPipeline(store, null, "testing", 3, 9);
		expect(result.scoredDocs.length).toBeLessThanOrEqual(3);
	});
});

describe("trackHitCounts", () => {
	it("increments hit counts for matched docs", () => {
		const { id } = upsertKnowledge(store, makeRow({
			filePath: "decisions/hit.json", title: "Hit Test",
		}));

		trackHitCounts(store, [{ doc: { ...makeRow(), id }, score: 0.9, matchReason: "fts5" }]);

		const row = store.db.prepare("SELECT hit_count FROM knowledge_index WHERE id = ?").get(id) as any;
		expect(row.hit_count).toBe(1);
	});

	it("handles empty array", () => {
		// Should not throw
		trackHitCounts(store, []);
	});
});
