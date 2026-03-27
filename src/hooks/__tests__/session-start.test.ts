import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-session-test");
const STATE_DIR = join(TEST_DIR, ".alfred", ".state");
let stdoutCapture: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stdoutCapture = [];

	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

function getResponse(): Record<string, unknown> | null {
	const output = stdoutCapture.join("");
	if (!output) return null;
	return JSON.parse(output);
}

describe("sessionStart hook", () => {
	it("creates .alfred dir if missing", async () => {
		rmSync(join(TEST_DIR, ".alfred"), { recursive: true, force: true });

		const handler = (await import("../session-start.ts")).default;
		await handler({ hook_type: "SessionStart" });

		const { existsSync } = await import("node:fs");
		expect(existsSync(join(TEST_DIR, ".alfred", ".state"))).toBe(true);
	});

	it("does not inject context when no errors", async () => {
		const handler = (await import("../session-start.ts")).default;
		await handler({ hook_type: "SessionStart" });

		expect(getResponse()).toBeNull();
	});

	it("clears stale pending-fixes from previous session", async () => {
		const { writeFileSync } = await import("node:fs");
		const fixesPath = join(TEST_DIR, ".alfred", ".state", "pending-fixes.json");
		writeFileSync(
			fixesPath,
			JSON.stringify([{ file: "old.ts", errors: ["stale error"], gate: "lint" }]),
		);

		const handler = (await import("../session-start.ts")).default;
		await handler({ hook_type: "SessionStart" });

		const { readFileSync } = await import("node:fs");
		const fixes = JSON.parse(readFileSync(fixesPath, "utf-8"));
		expect(fixes).toEqual([]);
	});
});
