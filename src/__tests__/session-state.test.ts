import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkBudget,
	clearOnCommit,
	isPaceRed,
	isReviewRequired,
	markGateRan,
	readPace,
	readSessionState,
	recordFailure,
	recordInjection,
	recordReview,
	recordTestPass,
	resetBudget,
	shouldSkipGate,
	writePace,
} from "../state/session-state.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-session-state");
const STATE_DIR = join(TEST_DIR, ".alfred", ".state");
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("session-state: pace tracking", () => {
	it("read returns null when no state", () => {
		expect(readPace()).toBeNull();
	});

	it("write and read pace", () => {
		const now = new Date().toISOString();
		writePace({ last_commit_at: now, changed_files: 3, tool_calls: 5 });
		const pace = readPace();
		expect(pace).not.toBeNull();
		expect(pace!.changed_files).toBe(3);
		expect(pace!.tool_calls).toBe(5);
	});
});

describe("session-state: isPaceRed", () => {
	it("returns false at 50 min with 7 files (below new default)", () => {
		const pace = {
			last_commit_at: new Date(Date.now() - 50 * 60_000).toISOString(),
			changed_files: 7,
		};
		expect(isPaceRed(pace)).toBe(false);
	});

	it("returns true at 125 min with 16 files", () => {
		const pace = {
			last_commit_at: new Date(Date.now() - 125 * 60_000).toISOString(),
			changed_files: 16,
		};
		expect(isPaceRed(pace)).toBe(true);
	});

	it("hasPlan gives more headroom (180 min / 23 files)", () => {
		const pace = {
			last_commit_at: new Date(Date.now() - 125 * 60_000).toISOString(),
			changed_files: 16,
		};
		// Without plan: 125 min >= 120, 16 >= 15 → red
		expect(isPaceRed(pace)).toBe(true);
		// With plan: 125 min < 180, threshold not met → not red
		expect(isPaceRed(pace, true)).toBe(false);
	});
});

describe("session-state: test pass tracking", () => {
	it("recordTestPass and read back", () => {
		recordTestPass("vitest run");
		const state = readSessionState();
		expect(state.test_passed_at).not.toBeNull();
		expect(state.test_command).toBe("vitest run");
	});

	it("clearOnCommit clears test pass", () => {
		recordTestPass("vitest run");
		clearOnCommit();
		const state = readSessionState();
		expect(state.test_passed_at).toBeNull();
	});
});

describe("session-state: review tracking", () => {
	it("recordReview and read back", () => {
		recordReview();
		const state = readSessionState();
		expect(state.review_completed_at).not.toBeNull();
	});

	it("clearOnCommit clears review", () => {
		recordReview();
		clearOnCommit();
		const state = readSessionState();
		expect(state.review_completed_at).toBeNull();
	});
});

describe("session-state: gate batch tracking", () => {
	it("shouldSkipGate returns false when not ran", () => {
		expect(shouldSkipGate("lint", "session-1")).toBe(false);
	});

	it("markGateRan then shouldSkipGate returns true for same session", () => {
		markGateRan("typecheck", "session-1");
		expect(shouldSkipGate("typecheck", "session-1")).toBe(true);
	});

	it("shouldSkipGate returns false for different session", () => {
		markGateRan("typecheck", "session-1");
		expect(shouldSkipGate("typecheck", "session-2")).toBe(false);
	});

	it("clearOnCommit clears gate batch", () => {
		markGateRan("typecheck", "session-1");
		clearOnCommit();
		expect(shouldSkipGate("typecheck", "session-1")).toBe(false);
	});
});

describe("session-state: fail count tracking", () => {
	it("recordFailure increments on same signature", () => {
		expect(recordFailure("err:timeout")).toBe(1);
		expect(recordFailure("err:timeout")).toBe(2);
		expect(recordFailure("err:timeout")).toBe(3);
	});

	it("recordFailure resets on different signature", () => {
		recordFailure("err:timeout");
		recordFailure("err:timeout");
		expect(recordFailure("err:other")).toBe(1);
	});

	it("clearOnCommit resets fail count", () => {
		recordFailure("err:timeout");
		recordFailure("err:timeout");
		clearOnCommit();
		expect(recordFailure("err:timeout")).toBe(1);
	});
});

describe("session-state: context budget", () => {
	it("resetBudget initializes budget", () => {
		resetBudget("session-1");
		expect(checkBudget(100)).toBe(true);
	});

	it("budget exceeded returns false", () => {
		resetBudget("session-1");
		recordInjection(1900);
		expect(checkBudget(200)).toBe(false);
	});

	it("same session does not reset", () => {
		resetBudget("session-1");
		recordInjection(500);
		resetBudget("session-1"); // same session — no reset
		expect(checkBudget(1600)).toBe(false); // still 500 used
	});

	it("new session resets budget", () => {
		resetBudget("session-1");
		recordInjection(1900);
		resetBudget("session-2"); // new session — reset
		expect(checkBudget(100)).toBe(true);
	});
});

describe("session-state: isReviewRequired", () => {
	it("required when plan is active", () => {
		// Create a plan file to simulate active plan
		const planDir = join(TEST_DIR, ".claude", "plans");
		const { mkdirSync, writeFileSync } = require("node:fs");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			"## Tasks\n### Task 1: test [pending]\n- **File**: foo.ts\n",
		);

		// Even with 0 changed files, plan makes review required
		expect(isReviewRequired()).toBe(true);
	});

	it("required when changed_files >= 5", () => {
		writePace({
			last_commit_at: new Date().toISOString(),
			changed_files: 5,
			tool_calls: 10,
		});

		expect(isReviewRequired()).toBe(true);
	});

	it("not required when changed_files < 5 and no plan", () => {
		writePace({
			last_commit_at: new Date().toISOString(),
			changed_files: 2,
			tool_calls: 5,
		});

		expect(isReviewRequired()).toBe(false);
	});

	it("not required when no state (fresh session, no plan)", () => {
		expect(isReviewRequired()).toBe(false);
	});
});

describe("session-state: clearOnCommit preserves budget", () => {
	it("budget survives clearOnCommit", () => {
		resetBudget("session-1");
		recordInjection(500);
		clearOnCommit();
		// Budget should still have 500 used
		const state = readSessionState();
		expect(state.context_used).toBe(500);
	});
});
