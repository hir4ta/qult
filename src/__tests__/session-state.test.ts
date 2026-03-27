import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAllCaches } from "../state/flush.ts";
import {
	checkBudget,
	clearOnCommit,
	countGatedFiles,
	isPaceRed,
	isReviewRequired,
	markGateRan,
	readPace,
	readSessionState,
	recordChangedFile,
	recordFailure,
	recordInjection,
	recordReview,
	recordTestPass,
	resetBudget,
	shouldSkipGate,
	writePace,
} from "../state/session-state.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-session-state");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
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

	it("required when gated files >= 5", () => {
		// Create gates.json with biome (covers .ts)
		const { writeFileSync } = require("node:fs");
		const qultDir = join(TEST_DIR, ".qult");
		writeFileSync(
			join(qultDir, "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
			}),
		);

		// Record 5 .ts files (gated)
		for (let i = 0; i < 5; i++) {
			recordChangedFile(`/project/src/file${i}.ts`);
		}

		expect(isReviewRequired()).toBe(true);
	});

	it("not required when only non-gated files changed", () => {
		// Create gates.json with biome (covers .ts, not .md)
		const { writeFileSync } = require("node:fs");
		const qultDir = join(TEST_DIR, ".qult");
		writeFileSync(
			join(qultDir, "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
			}),
		);

		// Record 10 .md files (not gated)
		for (let i = 0; i < 10; i++) {
			recordChangedFile(`/project/docs/file${i}.md`);
		}

		expect(isReviewRequired()).toBe(false);
	});

	it("not required when gated files < 5 (even with many non-gated)", () => {
		const { writeFileSync } = require("node:fs");
		const qultDir = join(TEST_DIR, ".qult");
		writeFileSync(
			join(qultDir, "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
			}),
		);

		// 2 .ts (gated) + 10 .md (not gated)
		recordChangedFile("/project/src/a.ts");
		recordChangedFile("/project/src/b.ts");
		for (let i = 0; i < 10; i++) {
			recordChangedFile(`/project/docs/file${i}.md`);
		}

		expect(isReviewRequired()).toBe(false);
	});

	it("not required when no state (fresh session, no plan)", () => {
		expect(isReviewRequired()).toBe(false);
	});
});

describe("session-state: countGatedFiles", () => {
	it("counts only files with gated extensions", () => {
		const { writeFileSync } = require("node:fs");
		const qultDir = join(TEST_DIR, ".qult");
		writeFileSync(
			join(qultDir, "gates.json"),
			JSON.stringify({
				on_write: {
					lint: { command: "biome check {file}", timeout: 3000 },
					typecheck: { command: "tsc --noEmit", timeout: 10000 },
				},
			}),
		);

		recordChangedFile("/project/src/app.ts");
		recordChangedFile("/project/src/utils.tsx");
		recordChangedFile("/project/CLAUDE.md");
		recordChangedFile("/project/README.md");
		recordChangedFile("/project/config.json");

		// .ts, .tsx, .json are gated by biome/tsc; .md is not
		expect(countGatedFiles()).toBe(3);
	});

	it("returns 0 when no gates configured", () => {
		recordChangedFile("/project/src/app.ts");
		expect(countGatedFiles()).toBe(0);
	});

	it("deduplicates file paths", () => {
		const { writeFileSync } = require("node:fs");
		const qultDir = join(TEST_DIR, ".qult");
		writeFileSync(
			join(qultDir, "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
			}),
		);

		recordChangedFile("/project/src/app.ts");
		recordChangedFile("/project/src/app.ts"); // duplicate
		recordChangedFile("/project/src/app.ts"); // duplicate

		expect(countGatedFiles()).toBe(1);
	});
});

describe("session-state: clearOnCommit resets changed_file_paths", () => {
	it("clears changed_file_paths on commit", () => {
		recordChangedFile("/project/src/app.ts");
		recordChangedFile("/project/src/utils.ts");
		expect(readSessionState().changed_file_paths).toHaveLength(2);

		clearOnCommit();
		expect(readSessionState().changed_file_paths).toHaveLength(0);
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
