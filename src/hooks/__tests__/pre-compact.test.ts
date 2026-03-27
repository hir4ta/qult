import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";
import { writePendingFixes } from "../../state/pending-fixes.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-precompact-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
let stderrCapture: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
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

describe("preCompact hook", () => {
	it("writes pending-fixes reminder to stderr", async () => {
		writePendingFixes([{ file: "src/a.ts", errors: ["err"], gate: "lint" }]);

		const handler = (await import("../pre-compact.ts")).default;
		await handler({ hook_type: "PreCompact" });

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("1 pending fix");
		expect(stderr).toContain("src/a.ts");
	});

	it("does nothing when no pending fixes", async () => {
		const handler = (await import("../pre-compact.ts")).default;
		await handler({ hook_type: "PreCompact" });

		expect(stderrCapture.join("")).toBe("");
	});
});
