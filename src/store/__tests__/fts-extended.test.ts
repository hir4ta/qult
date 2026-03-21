import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeRow } from "../../types.js";
import {
	detectKnowledgeConflicts,
	searchKnowledgeFTS,
	subTypeBoost,
	subTypeHalfLife,
} from "../fts.js";
import { Store } from "../index.js";
import { upsertKnowledge } from "../knowledge.js";

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
	tmpDir = mkdtempSync(join(tmpdir(), "fts-ext-test-"));
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
		branch: "main", createdAt: new Date().toISOString(),
		updatedAt: "", hitCount: 0, lastAccessed: "", enabled: true, ...overrides,
	};
}

describe("subTypeBoost", () => {
	it("rule gets 2.0x boost", () => expect(subTypeBoost("rule")).toBe(2.0));
	it("decision gets 1.5x boost", () => expect(subTypeBoost("decision")).toBe(1.5));
	it("pattern gets 1.3x boost", () => expect(subTypeBoost("pattern")).toBe(1.3));
	it("snapshot gets 1.0x (no boost)", () => expect(subTypeBoost("snapshot")).toBe(1.0));
	it("unknown gets 1.0x", () => expect(subTypeBoost("unknown")).toBe(1.0));
});

describe("subTypeHalfLife", () => {
	it("rule has 120 day half-life", () => expect(subTypeHalfLife("rule")).toBe(120));
	it("decision has 90 day half-life", () => expect(subTypeHalfLife("decision")).toBe(90));
	it("pattern has 90 day half-life", () => expect(subTypeHalfLife("pattern")).toBe(90));
	it("assumption has 30 day half-life", () => expect(subTypeHalfLife("assumption")).toBe(30));
	it("inference has 45 day half-life", () => expect(subTypeHalfLife("inference")).toBe(45));
	it("snapshot has 30 day half-life", () => expect(subTypeHalfLife("snapshot")).toBe(30));
	it("unknown defaults to 60", () => expect(subTypeHalfLife("unknown")).toBe(60));
});


describe("searchKnowledgeFTS", () => {
	it("finds entries matching query", () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/auth.json", title: "Authentication Design",
			content: "Use JWT tokens for authentication",
		}));

		const results = searchKnowledgeFTS(store, "authentication", 10);
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0]!.title).toContain("Authentication");
	});

	it("returns empty for no matches", () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/other.json", title: "Other",
			content: "Something else entirely",
		}));

		const results = searchKnowledgeFTS(store, "xyznonexistent", 10);
		expect(results.length).toBe(0);
	});

	it("excludes disabled entries", () => {
		const { id } = upsertKnowledge(store, makeRow({
			filePath: "decisions/disabled.json", title: "Disabled Entry",
			content: "This should not appear in search",
		}));
		store.db.prepare("UPDATE knowledge_index SET enabled = 0 WHERE id = ?").run(id);

		const results = searchKnowledgeFTS(store, "disabled", 10);
		expect(results.length).toBe(0);
	});

	it("respects limit", () => {
		for (let i = 0; i < 5; i++) {
			upsertKnowledge(store, makeRow({
				filePath: `decisions/d${i}.json`, title: `Decision about testing ${i}`,
				content: `Testing content for search testing ${i}`,
			}));
		}

		const results = searchKnowledgeFTS(store, "testing", 2);
		expect(results.length).toBeLessThanOrEqual(2);
	});
});

describe("detectKnowledgeConflicts", () => {
	it("returns empty when no embeddings", () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/a.json", title: "A", content: "content a",
		}));

		// No embeddings inserted → no conflicts detected
		const conflicts = detectKnowledgeConflicts(store);
		expect(conflicts.length).toBe(0);
	});
});
