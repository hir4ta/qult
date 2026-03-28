import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-session-test");
const QULT_DIR = join(TEST_DIR, ".qult");
const STATE_DIR = join(QULT_DIR, ".state");
let stdoutCapture: string[] = [];
const originalCwd = process.cwd();

/** Minimal gates config for tests that need gates present */
const SAMPLE_GATES = JSON.stringify({
	on_write: { lint: { command: "echo ok", timeout: 3000 } },
});

beforeEach(() => {
	resetAllCaches();
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
	it("creates .qult dir if missing", async () => {
		rmSync(join(TEST_DIR, ".qult"), { recursive: true, force: true });

		const handler = (await import("../session-start.ts")).default;
		await handler({ hook_type: "SessionStart" });

		const { existsSync } = await import("node:fs");
		expect(existsSync(join(TEST_DIR, ".qult", ".state"))).toBe(true);
	});

	it("does not inject context when gates configured and no errors", async () => {
		writeFileSync(join(QULT_DIR, "gates.json"), SAMPLE_GATES);

		const handler = (await import("../session-start.ts")).default;
		await handler({ hook_type: "SessionStart" });

		expect(getResponse()).toBeNull();
	});

	it("prompts /qult:detect-gates when gates are empty", async () => {
		writeFileSync(join(QULT_DIR, "gates.json"), "{}");

		const handler = (await import("../session-start.ts")).default;
		await handler({ hook_type: "SessionStart" });

		const output = stdoutCapture.join("");
		expect(output).toContain("qult:detect-gates");
	});

	it("clears stale pending-fixes from previous session", async () => {
		const { writeFileSync } = await import("node:fs");
		const fixesPath = join(TEST_DIR, ".qult", ".state", "pending-fixes.json");
		writeFileSync(
			fixesPath,
			JSON.stringify([{ file: "old.ts", errors: ["stale error"], gate: "lint" }]),
		);
		// Reset cache so handler reads the stale file from disk
		const { resetAllCaches } = await import("../../state/flush.ts");
		resetAllCaches();

		const handler = (await import("../session-start.ts")).default;
		await handler({ hook_type: "SessionStart" });

		const { readPendingFixes } = await import("../../state/pending-fixes.ts");
		const fixes = readPendingFixes();
		expect(fixes).toEqual([]);
	});
});
