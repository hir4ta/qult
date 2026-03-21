import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../../store/index.js";
import { countKnowledge, upsertKnowledge } from "../../store/knowledge.js";
import type { KnowledgeRow } from "../../types.js";
import { resetWorkedSlugs, readWorkedSlugs } from "../state.js";

let tmpDir: string;
let store: Store;

// Mock openDefaultCached to return our test store
vi.mock("../../store/index.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../store/index.js")>();
	return {
		...mod,
		openDefaultCached: () => store,
	};
});

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "session-start-test-"));
	store = Store.open(join(tmpDir, "test.db"));
	insertTestProject(store.db);
});

afterEach(() => {
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

const TEST_PROJECT_ID = "test-project-id";

function insertTestProject(db: Database.Database, id = TEST_PROJECT_ID): string {
	db.prepare(`
		INSERT OR IGNORE INTO projects (id, name, remote, path, branch, registered_at, last_seen_at, status)
		VALUES (?, 'test', '', '/test', '', datetime('now'), datetime('now'), 'active')
	`).run(id);
	return id;
}

function makeKnowledgeRow(overrides: Partial<KnowledgeRow> = {}): KnowledgeRow {
	return {
		id: 0, filePath: "decisions/test.json", contentHash: "", title: "Test",
		content: '{"id":"test","title":"Test"}', subType: "decision",
		projectId: TEST_PROJECT_ID,
		branch: "main", createdAt: new Date().toISOString(), updatedAt: "",
		hitCount: 0, lastAccessed: "", enabled: true, author: "", ...overrides,
	};
}

function suppressStderr(): { restore: () => void; lines: string[] } {
	const lines: string[] = [];
	const orig = process.stderr.write;
	process.stderr.write = ((chunk: string | Buffer) => {
		lines.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	return { restore: () => { process.stderr.write = orig; }, lines };
}

function suppressStdout(): { restore: () => void } {
	const orig = process.stdout.write;
	process.stdout.write = (() => true) as typeof process.stdout.write;
	return { restore: () => { process.stdout.write = orig; } };
}

describe("worked-slugs reset", () => {
	it("resets worked-slugs to empty array", () => {
		mkdirSync(join(tmpDir, ".alfred", ".state"), { recursive: true });
		writeFileSync(join(tmpDir, ".alfred", ".state", "worked-slugs.json"), JSON.stringify(["old-task"]));
		resetWorkedSlugs(tmpDir);
		expect(readWorkedSlugs(tmpDir)).toEqual([]);
	});

	it("returns empty array when no state file", () => {
		mkdirSync(join(tmpDir, ".alfred", ".state"), { recursive: true });
		expect(readWorkedSlugs(tmpDir)).toEqual([]);
	});
});

describe("sessionStart", () => {
	it("returns early when cwd is empty", async () => {
		const { sessionStart } = await import("../session-start.js");
		await sessionStart({ cwd: "" } as any, AbortSignal.timeout(5000));
	});

	it("suggests /alfred:init when steering docs missing", async () => {
		mkdirSync(join(tmpDir, ".alfred"), { recursive: true });
		const stderr = suppressStderr();
		const stdout = suppressStdout();
		try {
			const { sessionStart } = await import("../session-start.js");
			await sessionStart({ cwd: tmpDir } as any, AbortSignal.timeout(5000));
			expect(stderr.lines.some((l) => l.includes("/alfred:init"))).toBe(true);
		} finally {
			stderr.restore();
			stdout.restore();
		}
	});

	it("syncs knowledge JSON files from decisions/patterns/rules", async () => {
		const decisionsDir = join(tmpDir, ".alfred", "knowledge", "decisions");
		mkdirSync(decisionsDir, { recursive: true });
		writeFileSync(join(decisionsDir, "test-dec.json"),
			JSON.stringify({ id: "test-dec", title: "Test Decision", createdAt: "2025-01-01" }));

		const patternsDir = join(tmpDir, ".alfred", "knowledge", "patterns");
		mkdirSync(patternsDir, { recursive: true });
		writeFileSync(join(patternsDir, "test-pat.json"),
			JSON.stringify({ id: "test-pat", title: "Test Pattern", createdAt: "2025-01-01" }));

		// Create steering docs to suppress tips
		const steeringDir = join(tmpDir, ".alfred", "steering");
		mkdirSync(steeringDir, { recursive: true });
		writeFileSync(join(steeringDir, "product.md"), "# Product");

		const stderr = suppressStderr();
		const stdout = suppressStdout();
		try {
			const { sessionStart } = await import("../session-start.js");
			await sessionStart({ cwd: tmpDir } as any, AbortSignal.timeout(5000));
		} finally {
			stderr.restore();
			stdout.restore();
		}

		// Verify entries were upserted
		const rows = store.db.prepare("SELECT * FROM knowledge_index WHERE sub_type = 'decision'").all() as any[];
		expect(rows.length).toBeGreaterThanOrEqual(1);
		expect(rows.some((r: any) => r.file_path === "decisions/test-dec.json")).toBe(true);
	});

	it("cleans orphan entries", async () => {
		// Use resolveOrRegisterProject to get a project_id that sessionStart will use
		const { resolveOrRegisterProject } = await import("../../store/project.js");
		const projRecord = resolveOrRegisterProject(store, tmpDir);

		// Insert entry with matching project info but no corresponding file
		upsertKnowledge(store, makeKnowledgeRow({
			filePath: "decisions/orphan.json", title: "Orphan",
			projectId: projRecord.id, branch: projRecord.branch,
		}));
		expect((store.db.prepare("SELECT COUNT(*) as c FROM knowledge_index").get() as any).c).toBe(1);

		mkdirSync(join(tmpDir, ".alfred", "knowledge", "decisions"), { recursive: true });
		mkdirSync(join(tmpDir, ".alfred", "steering"), { recursive: true });
		writeFileSync(join(tmpDir, ".alfred", "steering", "product.md"), "# Product");

		const stderr = suppressStderr();
		const stdout = suppressStdout();
		try {
			const { sessionStart } = await import("../session-start.js");
			await sessionStart({ cwd: tmpDir } as any, AbortSignal.timeout(5000));
		} finally {
			stderr.restore();
			stdout.restore();
		}

		expect((store.db.prepare("SELECT COUNT(*) as c FROM knowledge_index").get() as any).c).toBe(0);
	});

	it("injects 1% rule context when .alfred exists", async () => {
		mkdirSync(join(tmpDir, ".alfred"), { recursive: true });
		mkdirSync(join(tmpDir, ".alfred", "steering"), { recursive: true });
		writeFileSync(join(tmpDir, ".alfred", "steering", "product.md"), "# Product");

		const stdoutWrites: string[] = [];
		const origStdout = process.stdout.write;
		process.stdout.write = ((chunk: string | Buffer) => {
			stdoutWrites.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		const stderr = suppressStderr();
		try {
			const { sessionStart } = await import("../session-start.js");
			await sessionStart({ cwd: tmpDir } as any, AbortSignal.timeout(5000));
			const output = stdoutWrites.join("");
			expect(output).toContain("alfred skill");
		} finally {
			process.stdout.write = origStdout;
			stderr.restore();
		}
	});

	it("builds spec context for active task", async () => {
		// Setup active spec
		const specsDir = join(tmpDir, ".alfred", "specs", "ctx-test");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(join(tmpDir, ".alfred", "specs", "_active.md"),
			"primary: ctx-test\ntasks:\n  - slug: ctx-test\n    started_at: '2025-01-01'\n    status: active\n    size: S\n");
		writeFileSync(join(specsDir, "session.md"), "# Session\n## Status: active\n## Current Focus\nTesting");
		writeFileSync(join(specsDir, "requirements.md"), "# Requirements\n## FR-1: Test feature");
		writeFileSync(join(specsDir, "tasks.md"), "# Tasks\n- [ ] T-1.1: Do thing");
		mkdirSync(join(tmpDir, ".alfred", "steering"), { recursive: true });
		writeFileSync(join(tmpDir, ".alfred", "steering", "product.md"), "# Product");

		const stdoutWrites: string[] = [];
		const origStdout = process.stdout.write;
		process.stdout.write = ((chunk: string | Buffer) => {
			stdoutWrites.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		const stderr = suppressStderr();
		try {
			const { sessionStart } = await import("../session-start.js");
			await sessionStart({ cwd: tmpDir } as any, AbortSignal.timeout(5000));
			const output = stdoutWrites.join("");
			expect(output).toContain("ctx-test");
		} finally {
			process.stdout.write = origStdout;
			stderr.restore();
		}
	});
});

describe("parseFrontmatter pattern", () => {
	function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
		const fm: Record<string, string> = {};
		if (!content.startsWith("---")) return { frontmatter: fm, body: content };
		const end = content.indexOf("---", 3);
		if (end === -1) return { frontmatter: fm, body: content };
		const fmBlock = content.slice(3, end).trim();
		for (const line of fmBlock.split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}
		return { frontmatter: fm, body: content.slice(end + 3).trim() };
	}

	it("parses YAML frontmatter", () => {
		const { frontmatter, body } = parseFrontmatter("---\nid: test\ntype: decision\n---\nBody");
		expect(frontmatter.id).toBe("test");
		expect(body).toBe("Body");
	});

	it("returns body when no frontmatter", () => {
		const { body } = parseFrontmatter("Plain text");
		expect(body).toBe("Plain text");
	});

	it("handles missing closing ---", () => {
		const { body } = parseFrontmatter("---\nid: test\nno closing");
		expect(body).toBe("---\nid: test\nno closing");
	});
});
