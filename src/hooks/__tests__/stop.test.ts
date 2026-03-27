import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";
import { writePendingFixes } from "../../state/pending-fixes.ts";
import { recordReview, writePace } from "../../state/session-state.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-stop-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
let stdoutCapture: string[] = [];
let stderrCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stdoutCapture = [];
	stderrCapture = [];
	exitCode = null;

	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((data) => {
		stderrCapture.push(typeof data === "string" ? data : data.toString());
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

	it("does not block when no pending-fixes and review completed", async () => {
		recordReview();

		const handler = (await import("../stop.ts")).default;
		await handler({ hook_type: "Stop" });

		expect(exitCode).toBeNull();
	});

	it("blocks when no review has been run and review is required (plan active)", async () => {
		// Create a plan to make review required
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			"## Tasks\n### Task 1: implement feature [done]\n",
		);

		const handler = (await import("../stop.ts")).default;
		try {
			await handler({ hook_type: "Stop" });
		} catch {
			// process.exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		expect((response as Record<string, string>)?.reason).toContain("review");
	});

	it("warns but does not block when no review and small change", async () => {
		// No plan, no changed files → review not required
		const handler = (await import("../stop.ts")).default;
		await handler({ hook_type: "Stop" });

		expect(exitCode).toBeNull();
		const stderr = stderrCapture.join("");
		expect(stderr).toContain("review");
	});

	it("does not block when stop_hook_active is true (prevent infinite loop)", async () => {
		writePendingFixes([{ file: "src/foo.ts", errors: ["lint error"], gate: "lint" }]);

		const handler = (await import("../stop.ts")).default;
		await handler({ hook_type: "Stop", stop_hook_active: true });

		expect(exitCode).toBeNull();
	});

	it("warns on pace yellow (20+ min) via stderr", async () => {
		recordReview();
		writePace({
			last_commit_at: new Date(Date.now() - 25 * 60_000).toISOString(),
			changed_files: 3,
			tool_calls: 20,
		});

		const handler = (await import("../stop.ts")).default;
		await handler({ hook_type: "Stop" });

		expect(exitCode).toBeNull();
		const stderr = stderrCapture.join("");
		expect(stderr).toContain("minutes since last commit");
	});
});
