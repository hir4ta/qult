import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../../store/index.js";
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

function setupActiveSpec(slug: string, tasksJson?: object) {
	const specsDir = join(tmpDir, ".alfred", "specs", slug);
	mkdirSync(specsDir, { recursive: true });
	const state = { primary: slug, tasks: [{ slug, started_at: "2025-01-01", status: "active", size: "S", spec_type: "feature" }] };
	writeFileSync(join(tmpDir, ".alfred", "specs", "_active.json"), JSON.stringify(state));
	writeFileSync(join(specsDir, "requirements.md"), "# Requirements");
	if (tasksJson) {
		writeFileSync(join(specsDir, "tasks.json"), JSON.stringify(tasksJson));
	}
}

describe("preCompact (FR-6: extractDecisions removed)", () => {
	it("does NOT extract decisions from transcript (agent hook handles this)", async () => {
		const transcript = JSON.stringify({ role: "assistant", content: "We decided to use PostgreSQL because it's the best choice. Instead of MySQL." });
		const transcriptPath = join(tmpDir, "transcript.jsonl");
		writeFileSync(transcriptPath, transcript);
		setupActiveSpec("no-extract");

		const io = suppressIO();
		try {
			const { preCompact } = await import("../pre-compact.js");
			await preCompact({ cwd: tmpDir, transcript_path: transcriptPath } as any, AbortSignal.timeout(5000));
		} finally { io.restore(); }

		const rows = store.db.prepare("SELECT * FROM knowledge_index WHERE sub_type = 'decision'").all() as any[];
		expect(rows.length).toBe(0);
	});

	it("writes pending-compact breadcrumb", async () => {
		setupActiveSpec("breadcrumb");

		const io = suppressIO();
		try {
			const { preCompact } = await import("../pre-compact.js");
			await preCompact({ cwd: tmpDir } as any, AbortSignal.timeout(5000));
		} finally { io.restore(); }

		const breadcrumb = readFileSync(join(tmpDir, ".alfred", ".pending-compact.json"), "utf-8");
		expect(breadcrumb).toContain("breadcrumb");
	});

	it("saves chapter memory snapshot when tasks.json exists", async () => {
		const tasksJson = { slug: "snapshot", waves: [{ key: 1, title: "W1", tasks: [{ id: "T-1.1", title: "Task", checked: false }] }], closing: { key: "closing", title: "Closing", tasks: [] } };
		setupActiveSpec("snapshot", tasksJson);

		const io = suppressIO();
		try {
			const { preCompact } = await import("../pre-compact.js");
			await preCompact({ cwd: tmpDir } as any, AbortSignal.timeout(5000));
		} finally { io.restore(); }

		const rows = store.db.prepare("SELECT * FROM knowledge_index WHERE sub_type = 'snapshot'").all() as any[];
		expect(rows.length).toBeGreaterThan(0);
	});

	it("returns early when cwd is empty", async () => {
		const { preCompact } = await import("../pre-compact.js");
		await preCompact({ cwd: "" } as any, AbortSignal.timeout(5000));
	});
});
