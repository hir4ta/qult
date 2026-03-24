import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../../store/index.js";
import type { KnowledgeRow } from "../../types.js";
import { suppressIO } from "../../__tests__/test-utils.js";

let tmpDir: string;
let store: Store;

vi.mock("../../store/index.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../store/index.js")>();
	return {
		...mod,
		openDefaultCached: () => store,
	};
});

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pre-compact-test-"));
	store = Store.open(join(tmpDir, "test.db"));
});

afterEach(() => {
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function setupActiveSpec(slug: string, tasksContent: string, size = "S") {
	const specsDir = join(tmpDir, ".alfred", "specs", slug);
	mkdirSync(specsDir, { recursive: true });
	const state = { primary: slug, tasks: [{ slug, started_at: "2025-01-01", status: "active", size, spec_type: "feature" }] };
	writeFileSync(join(tmpDir, ".alfred", "specs", "_active.json"), JSON.stringify(state));
	writeFileSync(join(specsDir, "requirements.md"), "# Requirements");
	writeFileSync(join(specsDir, "tasks.md"), tasksContent);
}

describe("preCompact", () => {
	it("ignores user messages in transcript", async () => {
		const transcript = JSON.stringify({ role: "user", content: "I decided to use PostgreSQL because it scales better." });
		const transcriptPath = join(tmpDir, "transcript2.jsonl");
		writeFileSync(transcriptPath, transcript);
		setupActiveSpec("user-msg", "# Tasks\n- [ ] Todo\n");

		const io = suppressIO();
		try {
			const { preCompact } = await import("../pre-compact.js");
			await preCompact({ cwd: tmpDir, transcript_path: transcriptPath } as any, AbortSignal.timeout(5000));
		} finally { io.restore(); }

		const rows = store.db.prepare("SELECT * FROM knowledge_index WHERE sub_type = 'decision'").all() as any[];
		expect(rows.length).toBe(0);
	});

	it("requires minimum score 0.4", async () => {
		const transcript = JSON.stringify({ role: "assistant", content: "We decided on something." });
		const transcriptPath = join(tmpDir, "transcript3.jsonl");
		writeFileSync(transcriptPath, transcript);
		setupActiveSpec("low-score", "# Tasks\n- [ ] Todo\n");

		const io = suppressIO();
		try {
			const { preCompact } = await import("../pre-compact.js");
			await preCompact({ cwd: tmpDir, transcript_path: transcriptPath } as any, AbortSignal.timeout(5000));
		} finally { io.restore(); }

		const rows = store.db.prepare("SELECT * FROM knowledge_index WHERE sub_type = 'decision'").all() as any[];
		expect(rows.length).toBe(0);
	});

	it("writes pending-compact breadcrumb", async () => {
		setupActiveSpec("breadcrumb", "# Tasks\n- [ ] Todo\n");

		const io = suppressIO();
		try {
			const { preCompact } = await import("../pre-compact.js");
			await preCompact({ cwd: tmpDir } as any, AbortSignal.timeout(5000));
		} finally { io.restore(); }

		const breadcrumb = readFileSync(join(tmpDir, ".alfred", ".pending-compact.json"), "utf-8");
		expect(breadcrumb).toContain("breadcrumb");
	});

	it("auto-completes S spec when all tasks checked", async () => {
		setupActiveSpec("auto-s", "# Tasks\n- [x] Step 1\n- [x] Step 2");

		const io = suppressIO();
		try {
			const { preCompact } = await import("../pre-compact.js");
			await preCompact({ cwd: tmpDir } as any, AbortSignal.timeout(5000));
		} finally { io.restore(); }

		// completeTask moves entry to _complete.json; _active.json should have empty tasks
		const active = JSON.parse(readFileSync(join(tmpDir, ".alfred", "specs", "_active.json"), "utf-8"));
		expect(active.tasks.some((t: any) => t.status === "active")).toBe(false);
	});

	it("auto-completes when all tasks checked", async () => {
		setupActiveSpec("auto-ns", "# Tasks\n- [x] Step 1\n- [x] Step 2");

		const io = suppressIO();
		try {
			const { preCompact } = await import("../pre-compact.js");
			await preCompact({ cwd: tmpDir } as any, AbortSignal.timeout(5000));
		} finally { io.restore(); }

		// completeTask moves entry to _complete.json; _active.json should have empty tasks
		const active = JSON.parse(readFileSync(join(tmpDir, ".alfred", "specs", "_active.json"), "utf-8"));
		expect(active.tasks.some((t: any) => t.status === "active")).toBe(false);
	});

	it("returns early when cwd is empty", async () => {
		const { preCompact } = await import("../pre-compact.js");
		await preCompact({ cwd: "" } as any, AbortSignal.timeout(5000));
	});
});
