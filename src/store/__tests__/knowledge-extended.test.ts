import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeRow } from "../../types.js";
import { Store } from "../index.js";
import {
	countKnowledge,
	deleteKnowledge,
	deleteOrphanKnowledge,
	getKnowledgeByID,
	getKnowledgeByIDs,
	getKnowledgeStats,
	getPromotionCandidates,
	getRecentDecisions,
	incrementHitCount,
	promoteSubType,
	searchKnowledgeKeyword,
	setKnowledgeEnabled,
	upsertKnowledge,
} from "../knowledge.js";

function insertTestProject(store: Store, id = "test-project-id"): string {
	store.db.prepare(`
		INSERT OR IGNORE INTO projects (id, name, remote, path, branch, registered_at, last_seen_at, status)
		VALUES (?, 'test', '', '/project', '', datetime('now'), datetime('now'), 'active')
	`).run(id);
	return id;
}

let store: Store;
let tmpDir: string;
let projectId: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "knowledge-ext-test-"));
	store = Store.open(join(tmpDir, "test.db"));
	projectId = insertTestProject(store);
});

afterEach(() => {
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function makeRow(overrides: Partial<KnowledgeRow> = {}): KnowledgeRow {
	return {
		id: 0, filePath: "decisions/test.json", contentHash: "", title: "Test",
		content: "test content", subType: "decision", projectId,
		branch: "main",
		createdAt: new Date().toISOString(), updatedAt: "", hitCount: 0,
		lastAccessed: "", enabled: true, author: "", ...overrides,
	};
}

describe("deleteKnowledge", () => {
	it("deletes entry by id", () => {
		const { id } = upsertKnowledge(store, makeRow());
		deleteKnowledge(store, id);
		expect(getKnowledgeByID(store, id)).toBeUndefined();
	});
});

describe("getKnowledgeByID / getKnowledgeByIDs", () => {
	it("retrieves single entry", () => {
		const { id } = upsertKnowledge(store, makeRow({ title: "Find Me" }));
		const row = getKnowledgeByID(store, id);
		expect(row).toBeDefined();
		expect(row!.title).toBe("Find Me");
	});

	it("returns undefined for missing id", () => {
		expect(getKnowledgeByID(store, 99999)).toBeUndefined();
	});

	it("retrieves multiple entries", () => {
		const { id: id1 } = upsertKnowledge(store, makeRow({
			filePath: "decisions/a.json", title: "A",
		}));
		const { id: id2 } = upsertKnowledge(store, makeRow({
			filePath: "decisions/b.json", title: "B",
		}));

		const rows = getKnowledgeByIDs(store, [id1, id2]);
		expect(rows.length).toBe(2);
	});

	it("returns empty for empty ids array", () => {
		expect(getKnowledgeByIDs(store, [])).toEqual([]);
	});
});

describe("incrementHitCount", () => {
	it("increments hit count", () => {
		const { id } = upsertKnowledge(store, makeRow());
		incrementHitCount(store, [id]);

		const row = getKnowledgeByID(store, id);
		expect(row!.hitCount).toBe(1);
	});

	it("increments multiple entries", () => {
		const { id: id1 } = upsertKnowledge(store, makeRow({
			filePath: "decisions/h1.json",
		}));
		const { id: id2 } = upsertKnowledge(store, makeRow({
			filePath: "decisions/h2.json",
		}));

		incrementHitCount(store, [id1, id2]);

		expect(getKnowledgeByID(store, id1)!.hitCount).toBe(1);
		expect(getKnowledgeByID(store, id2)!.hitCount).toBe(1);
	});
});

describe("setKnowledgeEnabled", () => {
	it("disables an entry", () => {
		const { id } = upsertKnowledge(store, makeRow());
		setKnowledgeEnabled(store, id, false);

		const row = getKnowledgeByID(store, id);
		expect(row!.enabled).toBe(false);
	});

	it("re-enables an entry", () => {
		const { id } = upsertKnowledge(store, makeRow());
		setKnowledgeEnabled(store, id, false);
		setKnowledgeEnabled(store, id, true);

		const row = getKnowledgeByID(store, id);
		expect(row!.enabled).toBe(true);
	});
});

describe("getPromotionCandidates", () => {
	it("returns patterns with 15+ hits", () => {
		const { id } = upsertKnowledge(store, makeRow({
			filePath: "patterns/promo.json", title: "Promotable",
			subType: "pattern",
		}));
		store.db.prepare("UPDATE knowledge_index SET hit_count = 20 WHERE id = ?").run(id);

		const candidates = getPromotionCandidates(store);
		expect(candidates.length).toBeGreaterThanOrEqual(1);
		expect(candidates.some((c) => c.id === id)).toBe(true);
	});

	it("excludes decisions and rules", () => {
		const { id } = upsertKnowledge(store, makeRow({
			filePath: "decisions/no-promo.json", title: "Decision",
			subType: "decision",
		}));
		store.db.prepare("UPDATE knowledge_index SET hit_count = 20 WHERE id = ?").run(id);

		const candidates = getPromotionCandidates(store);
		expect(candidates.every((c) => c.subType === "pattern")).toBe(true);
	});
});

describe("promoteSubType", () => {
	it("changes pattern to rule", () => {
		const { id } = upsertKnowledge(store, makeRow({
			filePath: "patterns/promote.json", subType: "pattern",
		}));

		promoteSubType(store, id, "rule");
		const row = getKnowledgeByID(store, id);
		expect(row!.subType).toBe("rule");
	});
});

describe("getRecentDecisions", () => {
	it("returns decisions within time range", () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/recent.json", title: "Recent Decision",
			subType: "decision", createdAt: new Date().toISOString(),
		}));

		const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
		const results = getRecentDecisions(store, projectId, sevenDaysAgo, 5);
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it("excludes old decisions", () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/old.json", title: "Old Decision",
			subType: "decision", createdAt: "2020-01-01T00:00:00Z",
		}));

		const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
		const results = getRecentDecisions(store, projectId, sevenDaysAgo, 5);
		expect(results.length).toBe(0);
	});
});

describe("deleteOrphanKnowledge", () => {
	it("removes entries without source files", () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/orphan.json", title: "Orphan",
		}));

		const validFiles = new Set<string>(); // empty = all are orphans
		const deleted = deleteOrphanKnowledge(store, projectId, "main", validFiles);
		expect(deleted).toBe(1);
	});

	it("preserves entries with source files", () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/keep.json", title: "Keep",
		}));

		const validFiles = new Set(["decisions/keep.json"]);
		const deleted = deleteOrphanKnowledge(store, projectId, "main", validFiles);
		expect(deleted).toBe(0);
	});
});

describe("searchKnowledgeKeyword", () => {
	it("finds by keyword LIKE match", () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/kw.json", title: "Keyword Search Test",
			content: "content about SQLite database",
		}));

		const results = searchKnowledgeKeyword(store, "SQLite", 10);
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	it("returns empty for no match", () => {
		const results = searchKnowledgeKeyword(store, "nonexistent12345", 10);
		expect(results.length).toBe(0);
	});
});

describe("getKnowledgeStats", () => {
	it("returns stats summary", () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/s1.json", title: "Stat Test",
		}));

		const stats = getKnowledgeStats(store);
		expect(stats.total).toBeGreaterThanOrEqual(1);
		expect(stats.bySubType).toBeDefined();
		expect(stats.avgHitCount).toBeDefined();
		expect(stats.topAccessed).toBeDefined();
	});
});

describe("countKnowledge", () => {
	it("counts by project", () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/c1.json",
		}));
		upsertKnowledge(store, makeRow({
			filePath: "decisions/c2.json",
		}));

		expect(countKnowledge(store, projectId)).toBe(2);
	});

	it("returns 0 for empty project", () => {
		expect(countKnowledge(store, "nonexistent-project")).toBe(0);
	});
});
