import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHandoff } from "../../state/handoff.ts";
import { writePendingFixes } from "../../state/pending-fixes.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-session-end-test");
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(join(TEST_DIR, ".alfred", ".state"), { recursive: true });
	process.chdir(TEST_DIR);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("sessionEnd", () => {
	it("saves handoff state on session exit", async () => {
		writePendingFixes([{ file: "src/a.ts", errors: ["err"], gate: "lint" }]);

		const handler = (await import("../session-end.ts")).default;
		await handler({ hook_type: "SessionEnd" });

		const handoff = readHandoff();
		expect(handoff).not.toBeNull();
		expect(handoff!.pending_fixes).toBe(true);
	});

	it("saves handoff even with no pending fixes", async () => {
		const handler = (await import("../session-end.ts")).default;
		await handler({ hook_type: "SessionEnd" });

		const handoff = readHandoff();
		expect(handoff).not.toBeNull();
		expect(handoff!.pending_fixes).toBe(false);
	});
});
