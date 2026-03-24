import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	tmpDir = mkdtempSync(join(tmpdir(), "post-tool-ext-"));
	store = Store.open(join(tmpDir, "test.db"));
	mkdirSync(join(tmpDir, ".alfred", ".state"), { recursive: true });
});

afterEach(() => {
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function setupActiveSpec(slug: string) {
	const specsDir = join(tmpDir, ".alfred", "specs", slug);
	mkdirSync(specsDir, { recursive: true });
	const state = { primary: slug, tasks: [{ slug, started_at: "2025-01-01", status: "active", size: "S", spec_type: "feature" }] };
	writeFileSync(join(tmpDir, ".alfred", "specs", "_active.json"), JSON.stringify(state));
	writeFileSync(join(specsDir, "session.md"), "# Session\n## Status: active\n## Next Steps\n- [ ] Run tests\n- [ ] Fix bugs");
	writeFileSync(join(specsDir, "requirements.md"), "# Requirements");
	writeFileSync(join(specsDir, "tasks.md"), "# Tasks\n## Wave 1\n- [ ] T-1.1: Add `src/hooks/test.ts`\n- [ ] T-1.2: Update documentation");
}

describe("postToolUse Bash error handling", () => {
	it("emits test failure warning on test error", async () => {
		const io = suppressIO();
		try {
			const { postToolUse } = await import("../post-tool.js");
			await postToolUse({
				cwd: tmpDir, tool_name: "Bash",
				tool_response: { exitCode: 1, stdout: "3 failed, 10 passed", stderr: "" },
			} as any, AbortSignal.timeout(5000));
			const output = io.stdout.join("");
			expect(output).toContain("failure");
		} finally { io.restore(); }
	});

	it("handles normal Bash success without error", async () => {
		const io = suppressIO();
		try {
			const { postToolUse } = await import("../post-tool.js");
			await postToolUse({
				cwd: tmpDir, tool_name: "Bash",
				tool_response: { exitCode: 0, stdout: "all good" },
			} as any, AbortSignal.timeout(5000));
			// Should not error
		} finally { io.restore(); }
	});
});

describe("postToolUse Edit/Write tracking", () => {
	it("adds worked slug on Edit", async () => {
		setupActiveSpec("edit-test");
		const io = suppressIO();
		try {
			const { postToolUse } = await import("../post-tool.js");
			await postToolUse({
				cwd: tmpDir, tool_name: "Edit",
				tool_input: { file_path: join(tmpDir, "src", "test.ts") },
			} as any, AbortSignal.timeout(5000));

			const { readWorkedSlugs } = await import("../state.js");
			const slugs = readWorkedSlugs(tmpDir);
			expect(slugs).toContain("edit-test");
		} finally { io.restore(); }
	});
});

describe("postToolUse returns early", () => {
	it("returns early without cwd", async () => {
		const { postToolUse } = await import("../post-tool.js");
		// Should not throw
		await postToolUse({ cwd: "", tool_name: "Bash" } as any, AbortSignal.timeout(5000));
	});

	it("returns early without tool_name", async () => {
		const { postToolUse } = await import("../post-tool.js");
		await postToolUse({ cwd: tmpDir } as any, AbortSignal.timeout(5000));
	});
});


