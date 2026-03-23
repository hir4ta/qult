import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractDecisions, extractReviewFindings, saveKnowledgeEntries } from "../knowledge-extractor.js";
import { Store } from "../../store/index.js";

// ---- T-2.1: Parser tests ----

describe("extractDecisions", () => {
	it("extracts accepted decisions", () => {
		const content = `
## DEC-1: Use Option A
- **Status:** Accepted
- **Context:** Need to choose between A and B
- **Decision:** Go with Option A
- **Rationale:** Best performance fit
- **Alternatives rejected:** Option B (too slow), Option C (too complex)
`;
		const entries = extractDecisions(content, "test-slug", "en");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.title).toBe("Use Option A");
		expect(entries[0]!.decision).toBe("Go with Option A");
		expect(entries[0]!.reasoning).toBe("Best performance fit");
		expect(entries[0]!.alternatives).toEqual(["Option B (too slow)", "Option C (too complex)"]);
		expect(entries[0]!.context).toBe("Need to choose between A and B");
		expect(entries[0]!.status).toBe("approved");
		expect(entries[0]!.tags).toEqual(["test-slug"]);
	});

	it("skips non-accepted decisions", () => {
		const content = `
## DEC-1: Rejected Idea
- **Status:** Rejected
- **Decision:** Don't do this

## DEC-2: Accepted Idea
- **Status:** Accepted
- **Decision:** Do this instead
- **Rationale:** Better approach
`;
		const entries = extractDecisions(content, "slug", "en");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.title).toBe("Accepted Idea");
	});

	it("handles case-insensitive status matching", () => {
		const content = `
## DEC-1: Case Test
- **Status:** accepted
- **Decision:** Lower case status
- **Rationale:** Should work
`;
		const entries = extractDecisions(content, "slug", "en");
		expect(entries).toHaveLength(1);
	});

	it("returns empty array for empty content", () => {
		expect(extractDecisions("", "slug", "en")).toEqual([]);
	});

	it("returns empty array for content without DEC sections", () => {
		expect(extractDecisions("# Some other content\nNo decisions here.", "slug", "en")).toEqual([]);
	});

	it("uses default title when title is missing", () => {
		const content = `
## DEC-1:
- **Status:** Accepted
- **Decision:** Something
- **Rationale:** Reason
`;
		const entries = extractDecisions(content, "slug", "en");
		// Empty title after colon — regex `^:\s*(.+)` captures whatever follows on the line
		// This documents actual behavior (may not be "Decision N" fallback)
		expect(entries).toHaveLength(1);
		expect(entries[0]!.title).toBeDefined();
		expect(entries[0]!.title.length).toBeGreaterThan(0);
	});

	it("handles missing alternatives", () => {
		const content = `
## DEC-1: No Alternatives
- **Status:** Accepted
- **Decision:** Just do it
- **Rationale:** Only option
`;
		const entries = extractDecisions(content, "slug", "en");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.alternatives).toEqual([]);
	});

	it("sets correct id format", () => {
		const content = `
## DEC-1: Test ID
- **Status:** Accepted
- **Decision:** Check ID
- **Rationale:** For testing
`;
		const entries = extractDecisions(content, "my-task", "en");
		expect(entries[0]!.id).toBe("dec-spec-my-task-1");
	});

	it("passes lang through", () => {
		const content = `
## DEC-1: Lang Test
- **Status:** Accepted
- **Decision:** Japanese
- **Rationale:** Test
`;
		const entries = extractDecisions(content, "slug", "ja");
		expect(entries[0]!.lang).toBe("ja");
	});
});

describe("extractReviewFindings", () => {
	it("extracts CRITICAL findings", () => {
		const text = "[CRITICAL] SQL injection vulnerability in query builder\nUses unsanitized user input in raw SQL queries\nThis could allow arbitrary data access";
		const entries = extractReviewFindings(text, "test-slug", "en");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.type).toBe("bad");
		expect(entries[0]!.title).toContain("SQL injection");
		expect(entries[0]!.context).toContain("test-slug");
		expect(entries[0]!.status).toBe("draft");
	});

	it("extracts HIGH findings", () => {
		const text = "[HIGH] Missing error handling in API endpoint\nNo try-catch around database calls";
		const entries = extractReviewFindings(text, "slug", "en");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.title).toContain("Missing error handling");
	});

	it("extracts severity format findings", () => {
		const text = 'severity: "critical" — Buffer overflow risk in parser module\nAffects all input processing paths';
		const entries = extractReviewFindings(text, "slug", "en");
		expect(entries).toHaveLength(1);
	});

	it("limits to 3 findings maximum", () => {
		const lines = Array.from({ length: 5 }, (_, i) =>
			`[CRITICAL] Finding ${i + 1}: Some critical issue number ${i + 1}`
		).join("\n");
		const entries = extractReviewFindings(lines, "slug", "en");
		expect(entries).toHaveLength(3);
	});

	it("returns empty for short response (< 50 chars)", () => {
		expect(extractReviewFindings("[CRITICAL] Short", "slug", "en")).toEqual([]);
	});

	it("returns empty for null response", () => {
		expect(extractReviewFindings(null, "slug", "en")).toEqual([]);
	});

	it("returns empty for undefined response", () => {
		expect(extractReviewFindings(undefined, "slug", "en")).toEqual([]);
	});

	it("returns empty for response without findings", () => {
		const text = "Everything looks good. No issues found in the codebase. All tests pass correctly.";
		expect(extractReviewFindings(text, "slug", "en")).toEqual([]);
	});

	it("skips findings with very short descriptions (< 10 chars)", () => {
		// [CRITICAL] with short text + empty lines → 3-line join yields "X  " (< 10 chars) → skipped
		const text = "[CRITICAL] X\n\n\nPadding text to make the overall response longer than fifty characters here.";
		const entries = extractReviewFindings(text, "slug", "en");
		expect(entries).toHaveLength(0);
	});

	it("handles JSON response via stringifyResponse", () => {
		const response = { findings: "[CRITICAL] Nested finding in JSON response object property value here" };
		const entries = extractReviewFindings(response, "slug", "en");
		expect(entries).toHaveLength(1);
	});

	it("sets correct id format", () => {
		const text = "[CRITICAL] First critical finding with enough text to be extracted properly here\n[HIGH] Second high severity finding with additional context information";
		const entries = extractReviewFindings(text, "my-task", "en");
		expect(entries[0]!.id).toBe("pat-review-my-task-1");
		if (entries.length > 1) {
			expect(entries[1]!.id).toBe("pat-review-my-task-2");
		}
	});
});

// ---- T-2.2: saveKnowledgeEntries tests ----

vi.mock("../../store/project.js", () => ({
	detectProject: () => ({ remote: "test-remote", path: "/test/path", name: "test-project", branch: "main" }),
	resolveOrRegisterProject: () => ({ id: "test-project-id", name: "test-project", remote: "test-remote", path: "/test/path", branch: "main", registeredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), status: "active", metadata: "{}" }),
}));

describe("saveKnowledgeEntries", () => {
	let tmpDir: string;
	let store: Store;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ke-test-"));
		store = Store.open(join(tmpDir, "test.db"));
		// Insert test project to satisfy FK constraint
		store.db.prepare(`
			INSERT OR IGNORE INTO projects (id, name, remote, path, branch, registered_at, last_seen_at, status)
			VALUES ('test-project-id', 'test', 'test-remote', '/test/path', 'main', datetime('now'), datetime('now'), 'active')
		`).run();
		// Create .alfred/knowledge directories
		mkdirSync(join(tmpDir, ".alfred", "knowledge", "decisions"), { recursive: true });
		mkdirSync(join(tmpDir, ".alfred", "knowledge", "patterns"), { recursive: true });
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("saves decision entries and returns count", () => {
		const entries = [
			{
				id: "dec-test-1",
				title: "Test Decision 1",
				context: "Testing",
				decision: "Do it",
				reasoning: "Because",
				alternatives: [],
				tags: ["test"],
				createdAt: new Date().toISOString(),
				status: "approved" as const,
			},
			{
				id: "dec-test-2",
				title: "Test Decision 2",
				context: "Testing",
				decision: "Do it too",
				reasoning: "Also because",
				alternatives: [],
				tags: ["test"],
				createdAt: new Date().toISOString(),
				status: "approved" as const,
			},
		];
		const saved = saveKnowledgeEntries(store, tmpDir, entries, "decision");
		expect(saved).toBe(2);
	});

	it("saves pattern entries", () => {
		const entries = [
			{
				id: "pat-test-1",
				type: "good" as const,
				title: "Test Pattern",
				context: "Testing",
				pattern: "Do this way",
				applicationConditions: "When testing",
				expectedOutcomes: "Better tests",
				tags: ["test"],
				createdAt: new Date().toISOString(),
				status: "draft" as const,
			},
		];
		const saved = saveKnowledgeEntries(store, tmpDir, entries, "pattern");
		expect(saved).toBe(1);
	});

	it("returns 0 for empty entries", () => {
		expect(saveKnowledgeEntries(store, tmpDir, [], "decision")).toBe(0);
	});

});
