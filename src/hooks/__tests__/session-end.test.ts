import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePendingFixes } from "../../state/pending-fixes.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-session-end-test");
const originalCwd = process.cwd();
let stderrCapture: string[] = [];

beforeEach(() => {
	mkdirSync(join(TEST_DIR, ".alfred", ".state"), { recursive: true });
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

describe("sessionEnd", () => {
	it("logs pending fixes to stderr on exit", async () => {
		writePendingFixes([{ file: "src/a.ts", errors: ["err"], gate: "lint" }]);

		const handler = (await import("../session-end.ts")).default;
		await handler({ hook_type: "SessionEnd" });

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("1 pending fix");
		expect(stderr).toContain("src/a.ts");
	});

	it("does nothing when no pending fixes", async () => {
		const handler = (await import("../session-end.ts")).default;
		await handler({ hook_type: "SessionEnd" });

		expect(stderrCapture.join("")).toBe("");
	});
});
