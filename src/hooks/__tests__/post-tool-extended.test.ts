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
	writeFileSync(join(tmpDir, ".alfred", "specs", "_active.md"),
		`primary: ${slug}\ntasks:\n  - slug: ${slug}\n    started_at: "2025-01-01"\n    status: active\n    size: S\n    spec_type: feature\n    review_status: approved\n`);
	writeFileSync(join(specsDir, "session.md"), "# Session\n## Status: active\n## Next Steps\n- [ ] Run tests\n- [ ] Fix bugs");
	writeFileSync(join(specsDir, "requirements.md"), "# Requirements");
	writeFileSync(join(specsDir, "tasks.md"), "# Tasks\n## Wave 1\n- [ ] T-1.1: Add `src/hooks/test.ts`\n- [ ] T-1.2: Update documentation");
}

describe("postToolUse exploration tracking", () => {
	it("emits survey suggestion at 5 consecutive reads", async () => {
		const io = suppressIO();
		try {
			const { postToolUse } = await import("../post-tool.js");
			for (let i = 0; i < 5; i++) {
				await postToolUse({ cwd: tmpDir, tool_name: "Read", tool_input: {} } as any, AbortSignal.timeout(5000));
			}
			const output = io.stdout.join("");
			expect(output).toContain("survey");
		} finally { io.restore(); }
	});

	it("resets explore count on non-Read/Grep/Glob tool", async () => {
		const io = suppressIO();
		try {
			const { postToolUse } = await import("../post-tool.js");
			// Build up count
			for (let i = 0; i < 3; i++) {
				await postToolUse({ cwd: tmpDir, tool_name: "Grep", tool_input: {} } as any, AbortSignal.timeout(5000));
			}
			// Non-read tool resets
			await postToolUse({ cwd: tmpDir, tool_name: "Bash", tool_response: { exitCode: 0, stdout: "ok" } } as any, AbortSignal.timeout(5000));
			// Read again - should start from 0
			const { readStateText } = await import("../state.js");
			const count = parseInt(readStateText(tmpDir, "explore-count", "0"), 10);
			expect(count).toBe(0);
		} finally { io.restore(); }
	});
});

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

describe("postToolUse archive nudge", () => {
	it("suggests archive for PDF files", async () => {
		const io = suppressIO();
		try {
			const { postToolUse } = await import("../post-tool.js");
			await postToolUse({
				cwd: tmpDir, tool_name: "Read",
				tool_input: { file_path: "/docs/reference.pdf" },
			} as any, AbortSignal.timeout(5000));
			const output = io.stdout.join("");
			expect(output).toContain("archive");
		} finally { io.restore(); }
	});

	it("suggests archive for CSV files", async () => {
		const io = suppressIO();
		try {
			const { postToolUse } = await import("../post-tool.js");
			await postToolUse({
				cwd: tmpDir, tool_name: "Read",
				tool_input: { file_path: "/data/export.csv" },
			} as any, AbortSignal.timeout(5000));
			const output = io.stdout.join("");
			expect(output).toContain("archive");
		} finally { io.restore(); }
	});
});

