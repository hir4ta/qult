import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../store/index.js";
import { upsertKnowledge } from "../../store/knowledge.js";
import type { KnowledgeRow } from "../../types.js";
import { handleLedger } from "../ledger.js";

let tmpDir: string;
let store: Store;

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
	return JSON.parse(result.content[0]!.text);
}

function makeRow(overrides: Partial<KnowledgeRow> = {}): KnowledgeRow {
	return {
		id: 0, filePath: "decisions/test.json", contentHash: "", title: "Test",
		content: '{"id":"test","decision":"use X","reasoning":"because Y"}',
		subType: "decision", projectRemote: "", projectPath: tmpDir,
		projectName: "test", branch: "main", createdAt: new Date().toISOString(),
		updatedAt: "", hitCount: 0, lastAccessed: "", enabled: true, ...overrides,
	};
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "ledger-test-"));
	store = Store.open(join(tmpDir, "test.db"));
	// Create .alfred/knowledge dirs for save action
	mkdirSync(join(tmpDir, ".alfred", "knowledge", "decisions"), { recursive: true });
	mkdirSync(join(tmpDir, ".alfred", "knowledge", "patterns"), { recursive: true });
	mkdirSync(join(tmpDir, ".alfred", "knowledge", "rules"), { recursive: true });
});

afterEach(() => {
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("ledger search", () => {
	it("requires query", async () => {
		const result = await handleLedger(store, null, { action: "search" });
		const data = parseResult(result);
		expect(data.error).toContain("query is required");
	});

	it("returns results for matching query", async () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/auth.json", title: "Authentication Decision",
			content: '{"id":"auth","decision":"Use JWT for authentication","reasoning":"Stateless"}',
		}));

		const result = await handleLedger(store, null, {
			action: "search", query: "authentication",
		});
		const data = parseResult(result);
		expect(data.search_method).toBeDefined();
		expect(data.count).toBeDefined();
	});

	it("caps limit to 100", async () => {
		const result = await handleLedger(store, null, {
			action: "search", query: "test", limit: 200,
		});
		const data = parseResult(result);
		if (data.warning) {
			expect(data.warning).toContain("capped");
		}
	});

	it("filters by sub_type", async () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/d1.json", title: "Decision", subType: "decision",
			content: '{"id":"d1","decision":"X","reasoning":"Y"}',
		}));
		upsertKnowledge(store, makeRow({
			filePath: "patterns/p1.json", title: "Pattern", subType: "pattern",
			content: '{"id":"p1","pattern":"Z"}',
		}));

		const result = await handleLedger(store, null, {
			action: "search", query: "Decision", sub_type: "decision",
		});
		const data = parseResult(result);
		for (const r of data.results ?? []) {
			expect(r.sub_type).toBe("decision");
		}
	});

	it("excludes snapshots from search results", async () => {
		upsertKnowledge(store, makeRow({
			filePath: "chapters/test/chapter-1", title: "Session Snapshot",
			content: "snapshot data about testing", subType: "snapshot",
		}));

		const result = await handleLedger(store, null, {
			action: "search", query: "snapshot testing",
		});
		const data = parseResult(result);
		for (const r of data.results ?? []) {
			expect(r.sub_type).not.toBe("snapshot");
		}
	});
});

describe("ledger save", () => {
	it("saves a decision", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "decision", title: "Use SQLite",
			label: "database-choice", decision: "Use SQLite for embedded storage",
			reasoning: "No external dependencies needed",
			project_path: tmpDir,
		});
		const data = parseResult(result);
		expect(data.status).toBe("saved");
		expect(data.title).toBe("Use SQLite");
		expect(data.file_path).toContain("decisions/");
		expect(existsSync(join(tmpDir, ".alfred", "knowledge", data.file_path))).toBe(true);
	});

	it("saves a pattern", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "pattern", title: "Error Handling Pattern",
			label: "error-handling", pattern: "Wrap all DB calls in try-catch",
			pattern_type: "good", project_path: tmpDir,
		});
		const data = parseResult(result);
		expect(data.status).toBe("saved");
		expect(data.file_path).toContain("patterns/");
	});

	it("saves a rule", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "rule", title: "No Raw SQL",
			label: "no-raw-sql", key: "sql-safety", text: "Never use raw SQL outside src/store/",
			priority: "p0", project_path: tmpDir,
		});
		const data = parseResult(result);
		expect(data.status).toBe("saved");
		expect(data.file_path).toContain("rules/");
	});

	it("rejects missing sub_type", async () => {
		const result = await handleLedger(store, null, {
			action: "save", title: "No Type", label: "no-type",
		});
		const data = parseResult(result);
		expect(data.error).toContain("sub_type");
	});

	it("rejects missing title", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "decision", label: "no-title",
		});
		const data = parseResult(result);
		expect(data.error).toContain("title");
	});

	it("rejects missing label", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "decision", title: "Has Title",
		});
		const data = parseResult(result);
		expect(data.error).toContain("label");
	});

	it("rejects decision without decision field", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "decision", title: "No Decision",
			label: "test", reasoning: "some reason",
		});
		const data = parseResult(result);
		expect(data.error).toContain("decision field");
	});

	it("rejects decision without reasoning", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "decision", title: "No Reasoning",
			label: "test", decision: "do X",
		});
		const data = parseResult(result);
		expect(data.error).toContain("reasoning");
	});

	it("rejects pattern without pattern field", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "pattern", title: "No Pattern", label: "test",
		});
		const data = parseResult(result);
		expect(data.error).toContain("pattern field");
	});

	it("rejects rule without text field", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "rule", title: "No Text", label: "test", key: "k",
		});
		const data = parseResult(result);
		expect(data.error).toContain("text field");
	});

	it("rejects rule without key", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "rule", title: "No Key", label: "test", text: "t",
		});
		const data = parseResult(result);
		expect(data.error).toContain("key field");
	});

	it("rejects JSON object in title", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "decision", title: '{"status":"completed","prompt":"You are a reviewer"}',
			label: "test", decision: "X", reasoning: "Y", project_path: tmpDir,
		});
		const data = parseResult(result);
		expect(data.error).toContain("natural language");
		expect(data.error).toContain("not JSON");
	});

	it("rejects JSON array in title", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "pattern", title: '[{"type":"text"}]',
			label: "test", pattern: "X", project_path: tmpDir,
		});
		const data = parseResult(result);
		expect(data.error).toContain("not JSON");
	});

	it("rejects title exceeding 200 characters", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "decision", title: "A".repeat(201),
			label: "test", decision: "X", reasoning: "Y", project_path: tmpDir,
		});
		const data = parseResult(result);
		expect(data.error).toContain("200");
	});

	it("rejects JSON in decision field", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "decision", title: "Valid Title",
			label: "test", decision: '{"key":"value"}', reasoning: "Y", project_path: tmpDir,
		});
		const data = parseResult(result);
		expect(data.error).toContain("decision");
		expect(data.error).toContain("not JSON");
	});

	it("rejects JSON in pattern field", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "pattern", title: "Valid Title",
			label: "test", pattern: '{"status":"completed","content":[]}', project_path: tmpDir,
		});
		const data = parseResult(result);
		expect(data.error).toContain("pattern");
		expect(data.error).toContain("not JSON");
	});

	it("rejects whitespace-only title", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "decision", title: "   ",
			label: "test", decision: "X", reasoning: "Y",
		});
		const data = parseResult(result);
		expect(data.error).toContain("empty");
	});

	it("rejects JSON in label", async () => {
		const result = await handleLedger(store, null, {
			action: "save", sub_type: "decision", title: "Valid",
			label: '{"foo":"bar"}', decision: "X", reasoning: "Y",
		});
		const data = parseResult(result);
		expect(data.error).toContain("label");
		expect(data.error).toContain("not JSON");
	});

	it("second save with same content returns saved (idempotent file overwrite)", async () => {
		const params = {
			action: "save", sub_type: "decision", title: "Dup Test",
			label: "dup", decision: "X", reasoning: "Y", project_path: tmpDir,
		};
		const result1 = await handleLedger(store, null, params);
		const data1 = parseResult(result1);
		expect(data1.status).toBe("saved");

		// Second save writes the same file — DB upsert detects same content_hash
		const result2 = await handleLedger(store, null, params);
		const data2 = parseResult(result2);
		// The file path should be the same (deterministic ID from title)
		expect(data2.file_path).toBe(data1.file_path);
	});
});

describe("ledger promote", () => {
	it("promotes pattern to rule", async () => {
		// Insert a pattern with enough hit_count
		const { id } = upsertKnowledge(store, makeRow({
			filePath: "patterns/promote.json", title: "Promotable Pattern",
			content: '{"id":"promote","pattern":"test"}', subType: "pattern",
			hitCount: 15,
		}));
		// Manually set hit_count
		store.db.prepare("UPDATE knowledge_index SET hit_count = 15 WHERE id = ?").run(id);

		const result = await handleLedger(store, null, {
			action: "promote", id, sub_type: "rule",
		});
		const data = parseResult(result);
		expect(data.previous_sub_type).toBe("pattern");
		expect(data.new_sub_type).toBe("rule");
	});

	it("rejects non-pattern promotion", async () => {
		const { id } = upsertKnowledge(store, makeRow({
			filePath: "decisions/no-promote.json", title: "Decision",
			subType: "decision",
		}));

		const result = await handleLedger(store, null, {
			action: "promote", id, sub_type: "rule",
		});
		const data = parseResult(result);
		expect(data.error).toContain("only patterns");
	});

	it("rejects missing id", async () => {
		const result = await handleLedger(store, null, {
			action: "promote", sub_type: "rule",
		});
		const data = parseResult(result);
		expect(data.error).toContain("id is required");
	});

	it("rejects non-rule target", async () => {
		const result = await handleLedger(store, null, {
			action: "promote", id: 1, sub_type: "pattern",
		});
		const data = parseResult(result);
		expect(data.error).toContain("rule");
	});
});

describe("ledger candidates", () => {
	it("returns empty when no candidates", async () => {
		const result = await handleLedger(store, null, { action: "candidates" });
		const data = parseResult(result);
		expect(data.candidates).toEqual([]);
		expect(data.count).toBe(0);
	});

	it("returns patterns with high hit counts", async () => {
		const { id } = upsertKnowledge(store, makeRow({
			filePath: "patterns/high-hit.json", title: "High Hit Pattern",
			content: '{"id":"high","pattern":"test"}', subType: "pattern",
		}));
		store.db.prepare("UPDATE knowledge_index SET hit_count = 20 WHERE id = ?").run(id);

		const result = await handleLedger(store, null, { action: "candidates" });
		const data = parseResult(result);
		expect(data.count).toBeGreaterThanOrEqual(1);
		expect(data.candidates[0].suggested).toBe("rule");
	});
});

describe("ledger reflect", () => {
	it("returns stats summary", async () => {
		upsertKnowledge(store, makeRow({
			filePath: "decisions/r1.json", title: "Reflect Test",
		}));

		const result = await handleLedger(store, null, { action: "reflect" });
		const data = parseResult(result);
		expect(data.summary.total_memories).toBeGreaterThanOrEqual(1);
		expect(data.summary.by_sub_type).toBeDefined();
		expect(data.duplicates).toBeDefined();
		expect(data.contradictions).toBeDefined();
	});
});

describe("ledger unknown action", () => {
	it("returns error for unknown action", async () => {
		const result = await handleLedger(store, null, { action: "unknown" });
		const data = parseResult(result);
		expect(data.error).toContain("unknown");
	});

	it("returns message for removed stale action", async () => {
		const result = await handleLedger(store, null, { action: "stale" });
		const data = parseResult(result);
		expect(data.message).toContain("removed");
	});
});
