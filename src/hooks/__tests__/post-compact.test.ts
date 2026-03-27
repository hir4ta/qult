import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePendingFixes } from "../../state/pending-fixes.ts";

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
	it("warns about pending fixes via stderr", async () => {
		writePendingFixes([{ file: "src/auth.ts", errors: ["type error"], gate: "typecheck" }]);

		const handler = (await import("../post-compact.ts")).default;
		await handler({ hook_type: "PostCompact" });

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("pending lint/type fix");
	});

	it("does nothing when no pending fixes", async () => {
		const handler = (await import("../post-compact.ts")).default;
		await handler({ hook_type: "PostCompact" });

		expect(stderrCapture.join("")).toBe("");
	});
});
