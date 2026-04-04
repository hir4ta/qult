import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";
import { writePendingFixes } from "../../state/pending-fixes.ts";
import { recordReview, recordTaskVerifyResult } from "../../state/session-state.ts";

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
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("Fix");
	});

	it("does not block when no pending-fixes and review completed", async () => {
		recordReview();

		const handler = (await import("../stop.ts")).default;
		await handler({ hook_type: "Stop" });

		expect(exitCode).toBeNull();
	});

	it("blocks when no review has been run and review is required (plan active)", async () => {
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
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("review");
	});

	it("blocks when plan tasks have Verify field but no verify result recorded", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add feature [done]",
				"- **File**: src/foo.ts",
				"- **Verify**: src/__tests__/foo.test.ts:testFoo",
			].join("\n"),
		);
		recordReview();

		const handler = (await import("../stop.ts")).default;
		try {
			await handler({ hook_type: "Stop" });
		} catch {
			// process.exit(2)
		}

		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Verify");
		expect(stderrCapture.join("")).toContain("TaskCreate");
	});

	it("allows when plan tasks have Verify results recorded", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add feature [done]",
				"- **File**: src/foo.ts",
				"- **Verify**: src/__tests__/foo.test.ts:testFoo",
			].join("\n"),
		);
		recordReview();
		recordTaskVerifyResult("Task 1", false);

		const handler = (await import("../stop.ts")).default;
		await handler({ hook_type: "Stop" });

		expect(exitCode).toBeNull();
	});

	it("allows when plan tasks have no Verify field", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			["## Tasks", "### Task 1: Config update [done]", "- **File**: config.json"].join("\n"),
		);
		recordReview();

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
});
