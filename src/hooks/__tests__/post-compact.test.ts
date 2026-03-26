import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-post-compact-test");
const STATE_DIR = join(TEST_DIR, ".alfred", ".state");
let stderrCapture: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stderrCapture = [];
	vi.spyOn(process.stderr, "write").mockImplementation((data) => {
		stderrCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("postCompact", () => {
	it("injects handoff via stderr when handoff exists", async () => {
		// Write a handoff file
		writeFileSync(
			join(STATE_DIR, "handoff.json"),
			JSON.stringify({
				summary: "Working on auth feature",
				changed_files: ["src/auth.ts", "src/middleware.ts"],
				pending_fixes: true,
				next_steps: "Fix type errors in auth.ts",
				saved_at: "2026-03-27T10:00:00Z",
			}),
		);

		const handler = (await import("../post-compact.ts")).default;
		await handler({ hook_type: "PostCompact" });

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("auth feature");
		expect(stderr).toContain("auth.ts");
		expect(stderr).toContain("Fix type errors");
	});

	it("does nothing when no handoff exists", async () => {
		const handler = (await import("../post-compact.ts")).default;
		await handler({ hook_type: "PostCompact" });

		const stderr = stderrCapture.join("");
		expect(stderr).toBe("");
	});

	it("does not clear handoff (SessionStart responsibility)", async () => {
		writeFileSync(
			join(STATE_DIR, "handoff.json"),
			JSON.stringify({
				summary: "test",
				changed_files: [],
				pending_fixes: false,
				next_steps: "continue",
				saved_at: "2026-03-27T10:00:00Z",
			}),
		);

		const handler = (await import("../post-compact.ts")).default;
		await handler({ hook_type: "PostCompact" });

		// Handoff should still exist
		const { readHandoff } = await import("../../state/handoff.ts");
		expect(readHandoff()).not.toBeNull();
	});
});
