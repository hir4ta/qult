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

function setupActiveSpec(slug: string, tasksContent: string, size = "S", reviewStatus = "approved") {
	const specsDir = join(tmpDir, ".alfred", "specs", slug);
	mkdirSync(specsDir, { recursive: true });
	const active = `primary: ${slug}\ntasks:\n  - slug: ${slug}\n    started_at: "2025-01-01"\n    status: active\n    size: ${size}\n    spec_type: feature\n    review_status: ${reviewStatus}\n`;
	writeFileSync(join(tmpDir, ".alfred", "specs", "_active.md"), active);
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

		// completeTask removes done entries from _active.md; file may not exist
		const exists = existsSync(join(tmpDir, ".alfred", "specs", "_active.md"));
		if (exists) {
			const active = readFileSync(join(tmpDir, ".alfred", "specs", "_active.md"), "utf-8");
			expect(active).not.toContain("status: active");
		}
	});

	it("auto-completes when all tasks checked", async () => {
		setupActiveSpec("auto-ns", "# Tasks\n- [x] Step 1\n- [x] Step 2");

		const io = suppressIO();
		try {
			const { preCompact } = await import("../pre-compact.js");
			await preCompact({ cwd: tmpDir } as any, AbortSignal.timeout(5000));
		} finally { io.restore(); }

		// completeTask removes done entries from _active.md; file may not exist
		const exists = existsSync(join(tmpDir, ".alfred", "specs", "_active.md"));
		if (exists) {
			const active = readFileSync(join(tmpDir, ".alfred", "specs", "_active.md"), "utf-8");
			expect(active).not.toContain("status: active");
		}
	});

	it("skips auto-complete for M spec without approval", async () => {
		setupActiveSpec("m-block", "# Tasks\n- [x] All done", "M", "pending");

		const io = suppressIO();
		try {
			const { preCompact } = await import("../pre-compact.js");
			await preCompact({ cwd: tmpDir } as any, AbortSignal.timeout(5000));
		} finally { io.restore(); }

		expect(io.stderr.some((l) => l.includes("skipped auto-complete"))).toBe(true);
		const active = readFileSync(join(tmpDir, ".alfred", "specs", "_active.md"), "utf-8");
		expect(active).toContain("status: active");
	});

	it("returns early when cwd is empty", async () => {
		const { preCompact } = await import("../pre-compact.js");
		await preCompact({ cwd: "" } as any, AbortSignal.timeout(5000));
	});
});
