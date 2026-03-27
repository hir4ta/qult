import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";
import { writePendingFixes } from "../../state/pending-fixes.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-post-compact-test");
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

describe("postCompact — structured handoff", () => {
	it("injects pending fixes with file and error detail", async () => {
		writePendingFixes([{ file: "src/auth.ts", errors: ["type error"], gate: "typecheck" }]);

		const handler = (await import("../post-compact.ts")).default;
		await handler({ hook_type: "PostCompact" });

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("PENDING FIXES");
		expect(stderr).toContain("src/auth.ts");
		expect(stderr).toContain("typecheck");
	});

	it("always injects commit gate status", async () => {
		const handler = (await import("../post-compact.ts")).default;
		await handler({ hook_type: "PostCompact" });

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("Commit gates");
		expect(stderr).toContain("tests NOT passed");
		expect(stderr).toContain("review not completed");
	});

	it("injects plan progress after compaction", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "plan.md"),
			"## Tasks\n### Task 1: Setup [done]\n- done\n### Task 2: Implement [in-progress]\n- wip\n### Task 3: Test [pending]\n- todo",
		);

		const handler = (await import("../post-compact.ts")).default;
		await handler({ hook_type: "PostCompact" });

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("Done: Setup");
		expect(stderr).toContain("Remaining: Test");
	});

	it("injects pace status", async () => {
		// Session state with a commit timestamp
		writeFileSync(
			join(STATE_DIR, "session-state.json"),
			JSON.stringify({
				last_commit_at: new Date().toISOString(),
				changed_files: 5,
				tool_calls: 10,
			}),
		);

		const handler = (await import("../post-compact.ts")).default;
		await handler({ hook_type: "PostCompact" });

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("Pace:");
		expect(stderr).toContain("5 files changed");
	});
});
