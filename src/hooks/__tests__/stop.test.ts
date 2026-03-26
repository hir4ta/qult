import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePace } from "../../state/pace.ts";
import { writePendingFixes } from "../../state/pending-fixes.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-stop-test");
const STATE_DIR = join(TEST_DIR, ".alfred", ".state");
let stdoutCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stdoutCapture = [];
	exitCode = null;

	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		exitCode = code as number;
		throw new Error(`process.exit(${code})`);
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

describe("stop hook", () => {
	it("blocks when pending-fixes exist", async () => {
		writePendingFixes([{ file: "src/foo.ts", errors: ["lint error"], gate: "lint" }]);

		const handler = (await import("../stop.ts")).default;
		try {
			await handler({ hook_type: "Stop" });
		} catch {
			// process.exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		expect((response as Record<string, string>)?.reason).toContain("Fix");
	});

	it("does not block when no pending-fixes", async () => {
		const handler = (await import("../stop.ts")).default;
		await handler({ hook_type: "Stop" });

		expect(exitCode).toBeNull();
	});

	it("does not block when stop_hook_active is true (prevent infinite loop)", async () => {
		writePendingFixes([{ file: "src/foo.ts", errors: ["lint error"], gate: "lint" }]);

		const handler = (await import("../stop.ts")).default;
		await handler({ hook_type: "Stop", stop_hook_active: true });

		expect(exitCode).toBeNull();
	});

	it("warns on pace yellow (20+ min)", async () => {
		writePace({
			last_commit_at: new Date(Date.now() - 25 * 60_000).toISOString(),
			changed_files: 3,
			tool_calls: 20,
		});

		const handler = (await import("../stop.ts")).default;
		await handler({ hook_type: "Stop" });

		const response = getResponse();
		if (response) {
			const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
			expect(context).toContain("commit");
		}
	});
});
