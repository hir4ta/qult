import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, setProjectPath, useTestDb } from "../state/db.ts";
import { resetAllCaches } from "../state/flush.ts";
import {
	clearOnCommit,
	incrementFileEditCount,
	incrementGateFailure,
	isReviewRequired,
	readFileEditCount,
	readSessionState,
	recordChangedFile,
	recordReview,
	recordTestPass,
	resetFileEditCounts,
	resetGateFailure,
} from "../state/session-state.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-session-state");
const originalCwd = process.cwd();

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	resetAllCaches();
	mkdirSync(TEST_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	closeDb();
	rmSync(TEST_DIR, { recursive: true, force: true });
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

describe("session-state: isReviewRequired", () => {
	it("required when plan is active", () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			"## Tasks\n### Task 1: test [pending]\n- **File**: foo.ts\n",
		);
		expect(isReviewRequired()).toBe(true);
	});

	it("required when changed files >= 5", () => {
		for (let i = 0; i < 5; i++) {
			recordChangedFile(`/project/src/file${i}.ts`);
		}
		expect(isReviewRequired()).toBe(true);
	});

	it("required when non-gated files >= threshold", () => {
		for (let i = 0; i < 5; i++) {
			recordChangedFile(`/project/docs/file${i}.md`);
		}
		expect(isReviewRequired()).toBe(true);
	});

	it("not required when changed files < threshold", () => {
		for (let i = 0; i < 4; i++) {
			recordChangedFile(`/project/docs/file${i}.md`);
		}
		expect(isReviewRequired()).toBe(false);
	});

	it("not required when no state (fresh session, no plan)", () => {
		expect(isReviewRequired()).toBe(false);
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

describe("session-state: gate failure escalation", () => {
	it("incrementGateFailure returns incrementing counts", () => {
		expect(incrementGateFailure("/src/a.ts", "lint")).toBe(1);
		expect(incrementGateFailure("/src/a.ts", "lint")).toBe(2);
		expect(incrementGateFailure("/src/a.ts", "lint")).toBe(3);
	});

	it("incrementGateFailure tracks different file:gate combinations independently", () => {
		expect(incrementGateFailure("/src/a.ts", "lint")).toBe(1);
		expect(incrementGateFailure("/src/a.ts", "typecheck")).toBe(1);
		expect(incrementGateFailure("/src/b.ts", "lint")).toBe(1);
		expect(incrementGateFailure("/src/a.ts", "lint")).toBe(2);
	});

	it("resetGateFailure clears count for specific file:gate", () => {
		incrementGateFailure("/src/a.ts", "lint");
		incrementGateFailure("/src/a.ts", "lint");
		resetGateFailure("/src/a.ts", "lint");
		// After reset, next increment starts from 1
		expect(incrementGateFailure("/src/a.ts", "lint")).toBe(1);
	});

	it("resetGateFailure is no-op for non-existent key", () => {
		// Should not throw
		resetGateFailure("/src/nonexistent.ts", "lint");
		expect(readSessionState().gate_failure_counts).toEqual({});
	});

	it("clearOnCommit resets gate_failure_counts", () => {
		incrementGateFailure("/src/a.ts", "lint");
		incrementGateFailure("/src/b.ts", "typecheck");
		clearOnCommit();
		expect(readSessionState().gate_failure_counts).toEqual({});
	});

	it("resetGateFailure deletes key even if count were 0 (truthiness fix)", () => {
		// Directly write a 0 value to simulate edge case
		const state = readSessionState();
		state.gate_failure_counts = { "/src/edge.ts:lint": 0 };
		// Use writeState indirectly by writing via incrementGateFailure then overwriting
		incrementGateFailure("/src/edge.ts", "lint");
		// Now manually set to 0 to test the truthiness fix
		const s2 = readSessionState();
		s2.gate_failure_counts["/src/edge.ts:lint"] = 0;
		// resetGateFailure should still delete the key (using `key in` not truthiness)
		resetGateFailure("/src/edge.ts", "lint");
		expect("/src/edge.ts:lint" in readSessionState().gate_failure_counts).toBe(false);
	});

	it("incrementGateFailure is capped at 100", () => {
		const state = readSessionState();
		state.gate_failure_counts = { "/src/loop.ts:lint": 99 };
		// Writing state directly to simulate 99 failures
		const count = incrementGateFailure("/src/loop.ts", "lint");
		expect(count).toBe(100);
		// One more should still be 100
		const count2 = incrementGateFailure("/src/loop.ts", "lint");
		expect(count2).toBe(100);
	});

	it("incrementGateFailure evicts oldest entries when key count exceeds 200", () => {
		// Insert 200 unique file:gate keys with count=1
		for (let i = 0; i < 200; i++) {
			incrementGateFailure(`/src/file${i}.ts`, "lint");
		}
		// All 200 should be present
		expect(Object.keys(readSessionState().gate_failure_counts).length).toBe(200);

		// Adding one more (201st) should trigger eviction back to 200
		incrementGateFailure("/src/file-extra.ts", "lint");
		expect(Object.keys(readSessionState().gate_failure_counts).length).toBe(200);
	});
});

describe("file_edit_counts", () => {
	it("returns 0 for untracked file", () => {
		expect(readFileEditCount("/src/foo.ts")).toBe(0);
	});

	it("increments and returns new count", () => {
		expect(incrementFileEditCount("/src/foo.ts")).toBe(1);
		expect(incrementFileEditCount("/src/foo.ts")).toBe(2);
		expect(incrementFileEditCount("/src/foo.ts")).toBe(3);
		expect(readFileEditCount("/src/foo.ts")).toBe(3);
	});

	it("tracks multiple files independently", () => {
		incrementFileEditCount("/src/a.ts");
		incrementFileEditCount("/src/a.ts");
		incrementFileEditCount("/src/b.ts");
		expect(readFileEditCount("/src/a.ts")).toBe(2);
		expect(readFileEditCount("/src/b.ts")).toBe(1);
	});

	it("resetFileEditCounts clears all counts", () => {
		incrementFileEditCount("/src/a.ts");
		incrementFileEditCount("/src/b.ts");
		resetFileEditCounts();
		expect(readFileEditCount("/src/a.ts")).toBe(0);
		expect(readFileEditCount("/src/b.ts")).toBe(0);
	});

	it("clearOnCommit resets file edit counts", () => {
		incrementFileEditCount("/src/a.ts");
		incrementFileEditCount("/src/a.ts");
		clearOnCommit();
		expect(readFileEditCount("/src/a.ts")).toBe(0);
	});
});
