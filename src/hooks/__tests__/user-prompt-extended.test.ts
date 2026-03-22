import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeRow } from "../../types.js";
import type { ScoredDoc } from "../../mcp/helpers.js";
import { Store } from "../../store/index.js";
import { insertTestProject, TEST_PROJECT_ID } from "../../__tests__/test-utils.js";
import {
	cosineSim,
	buildRelevanceExplanation,
	intentDescription,
} from "../user-prompt.js";

// ---- T-1.2: Pure function tests ----

describe("cosineSim", () => {
	it("returns 1.0 for identical vectors", () => {
		expect(cosineSim([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
	});

	it("returns 0 for orthogonal vectors", () => {
		expect(cosineSim([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
	});

	it("returns 0 for zero-length vector", () => {
		expect(cosineSim([0, 0, 0], [1, 0, 0])).toBe(0);
	});

	it("returns 0 for both zero vectors", () => {
		expect(cosineSim([0, 0, 0], [0, 0, 0])).toBe(0);
	});

	it("handles negative components", () => {
		expect(cosineSim([1, 0], [-1, 0])).toBeCloseTo(-1.0);
	});

	it("handles high-dimensional vectors", () => {
		const a = Array.from({ length: 128 }, (_, i) => Math.sin(i));
		const b = Array.from({ length: 128 }, (_, i) => Math.sin(i));
		expect(cosineSim(a, b)).toBeCloseTo(1.0);
	});
});

describe("buildRelevanceExplanation", () => {
	function makeScoredDoc(overrides: Partial<{ matchReason: string; subType: string; createdAt: string }>): ScoredDoc {
		return {
			score: 0.8,
			matchReason: overrides.matchReason ?? "vector",
			doc: {
				id: 1,
				filePath: "test.json",
				contentHash: "",
				title: "Test",
				content: "{}",
				subType: overrides.subType ?? "decision",
				projectId: "",
				branch: "",
				createdAt: overrides.createdAt ?? new Date().toISOString(),
				updatedAt: "",
				hitCount: 0,
				lastAccessed: "",
				enabled: true,
			author: "",
			},
		};
	}

	it("shows semantic match for vector matchReason", () => {
		const result = buildRelevanceExplanation(makeScoredDoc({ matchReason: "vector" }));
		expect(result).toContain("semantic match");
		expect(result).not.toContain("reranked");
	});

	it("shows reranked for vector+rerank", () => {
		const result = buildRelevanceExplanation(makeScoredDoc({ matchReason: "vector+rerank" }));
		expect(result).toContain("semantic match (reranked)");
	});

	it("shows keyword match for fts5", () => {
		const result = buildRelevanceExplanation(makeScoredDoc({ matchReason: "fts5" }));
		expect(result).toContain("keyword match");
	});

	it("shows decision boost 1.5x", () => {
		const result = buildRelevanceExplanation(makeScoredDoc({ subType: "decision" }));
		expect(result).toContain("decision boost 1.5x");
	});

	it("shows pattern boost 1.3x", () => {
		const result = buildRelevanceExplanation(makeScoredDoc({ subType: "pattern" }));
		expect(result).toContain("pattern boost 1.3x");
	});

	it("shows rule boost 2x", () => {
		const result = buildRelevanceExplanation(makeScoredDoc({ subType: "rule" }));
		expect(result).toContain("rule boost 2x");
	});

	it("no boost for snapshot (1.0x)", () => {
		const result = buildRelevanceExplanation(makeScoredDoc({ subType: "snapshot" }));
		expect(result).not.toContain("boost");
	});

	it("shows today for recent entries", () => {
		const result = buildRelevanceExplanation(makeScoredDoc({ createdAt: new Date().toISOString() }));
		expect(result).toContain("today");
	});

	it("shows Nd ago for entries within a week", () => {
		const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
		const result = buildRelevanceExplanation(makeScoredDoc({ createdAt: threeDaysAgo }));
		expect(result).toContain("3d ago");
	});

	it("shows Nw ago for entries within a month", () => {
		const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
		const result = buildRelevanceExplanation(makeScoredDoc({ createdAt: twoWeeksAgo }));
		expect(result).toContain("2w ago");
	});

	it("no age context for entries older than 30 days", () => {
		const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
		const result = buildRelevanceExplanation(makeScoredDoc({ createdAt: twoMonthsAgo }));
		expect(result).not.toContain("ago");
		expect(result).not.toContain("today");
	});

	it("returns empty string when no explanation parts", () => {
		// unknown matchReason + default boost (1.0) + old entry
		const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
		const result = buildRelevanceExplanation(makeScoredDoc({ matchReason: "unknown", subType: "snapshot", createdAt: old }));
		expect(result).toBe("");
	});
});

describe("intentDescription", () => {
	it("returns description for research", () => {
		expect(intentDescription("research")).toBe("Research and investigation structuring");
	});

	it("returns description for plan", () => {
		expect(intentDescription("plan")).toBe("Spec creation → approval → implementation");
	});

	it("returns same description for implement as plan", () => {
		expect(intentDescription("implement")).toBe(intentDescription("plan"));
	});

	it("returns description for bugfix", () => {
		expect(intentDescription("bugfix")).toBe("Reproduce → analyze → fix → verify");
	});

	it("returns description for review", () => {
		expect(intentDescription("review")).toBe("6-profile quality review");
	});

	it("returns description for tdd", () => {
		expect(intentDescription("tdd")).toBe("Red → Green → Refactor autonomous TDD");
	});

	it("returns empty string for unknown intent", () => {
		expect(intentDescription("unknown")).toBe("");
	});
});

// ---- T-1.3: Pipeline integration tests ----

// Re-import after mocks are set up
let store: Store;
let tmpDir: string;
let emittedItems: Array<{ level: string; message: string }>;

vi.mock("../../store/index.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../store/index.js")>();
	return {
		...mod,
		openDefaultCached: () => store,
	};
});

vi.mock("../../embedder/index.js", () => ({
	Embedder: {
		create: () => {
			throw new Error("No Voyage key");
		},
	},
}));

// Capture emitDirectives calls
vi.mock("../directives.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../directives.js")>();
	return {
		...mod,
		emitDirectives: (_eventName: string, items: Array<{ level: string; message: string }>) => {
			emittedItems = items;
		},
	};
});

// Dynamic import after mocks
const { userPromptSubmit } = await import("../user-prompt.js");

describe("userPromptSubmit pipeline", () => {
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "user-prompt-ext-"));
		store = Store.open(join(tmpDir, "test.db"));
		insertTestProject(store.db);
		emittedItems = [];
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("emits nothing for empty prompt", async () => {
		const ac = new AbortController();
		await userPromptSubmit({ prompt: "", cwd: tmpDir }, ac.signal);
		expect(emittedItems).toEqual([]);
	});

	it("emits nothing for missing prompt", async () => {
		const ac = new AbortController();
		await userPromptSubmit({ cwd: tmpDir }, ac.signal);
		expect(emittedItems).toEqual([]);
	});

	it("emits AskUserQuestion DIRECTIVE when .alfred exists but no spec", async () => {
		mkdirSync(join(tmpDir, ".alfred"), { recursive: true });
		const ac = new AbortController();
		await userPromptSubmit({ prompt: "implement login", cwd: tmpDir }, ac.signal);
		const directive = emittedItems.find((i) => i.level === "DIRECTIVE");
		expect(directive).toBeDefined();
		expect(directive!.message).toContain("AskUserQuestion");
	});

	it("emits skill nudge CONTEXT for implement intent without spec", async () => {
		const ac = new AbortController();
		await userPromptSubmit({ prompt: "implement something", cwd: tmpDir }, ac.signal);
		const nudge = emittedItems.find((i) => i.level === "CONTEXT" && i.message.includes("Skill suggestion"));
		expect(nudge).toBeDefined();
		expect(nudge!.message).toContain("/alfred:attend");
	});

	it("emits CONTEXT with knowledge results when store has entries", async () => {
		// Insert a knowledge entry for search
		const { upsertKnowledge } = await import("../../store/knowledge.js");
		const row: KnowledgeRow = {
			id: 0,
			filePath: "decisions/test.json",
			contentHash: "abc",
			title: "Test knowledge entry for login auth",
			content: JSON.stringify({ title: "Test login auth decision" }),
			subType: "decision",
			projectId: TEST_PROJECT_ID,
			branch: "main",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			hitCount: 0,
			lastAccessed: "",
			enabled: true,
			author: "",
		};
		upsertKnowledge(store, row);

		const ac = new AbortController();
		await userPromptSubmit({ prompt: "login auth decision", cwd: tmpDir }, ac.signal);
		const knowledge = emittedItems.find((i) => i.level === "CONTEXT" && i.message.includes("Related knowledge"));
		expect(knowledge).toBeDefined();
	});

	it("does not emit nudge for save-knowledge intent", async () => {
		const ac = new AbortController();
		await userPromptSubmit({ prompt: "save this note remember", cwd: tmpDir }, ac.signal);
		const nudge = emittedItems.find((i) => i.level === "CONTEXT" && i.message.includes("Skill suggestion"));
		expect(nudge).toBeUndefined();
	});

	it("emits DIRECTIVE for unapproved M spec", async () => {
		mkdirSync(join(tmpDir, ".alfred", "specs"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".alfred", "specs", "_active.md"),
			"primary: test-task\ntasks:\n  - slug: test-task\n    started_at: 2026-01-01T00:00:00Z\n    size: M\n    review_status: pending\n",
		);
		const ac = new AbortController();
		await userPromptSubmit({ prompt: "implement auth", cwd: tmpDir }, ac.signal);
		const directive = emittedItems.find((i) => i.level === "DIRECTIVE");
		expect(directive).toBeDefined();
		expect(directive!.message).toContain("requires review approval");
	});
});
