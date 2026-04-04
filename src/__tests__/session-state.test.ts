import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAllCaches } from "../state/flush.ts";
import {
	clearOnCommit,
	getGatedExtensions,
	incrementGateFailure,
	isReviewRequired,
	markGateRan,
	readSessionState,
	readTaskVerifyResult,
	recordChangedFile,
	recordReview,
	recordTaskVerifyResult,
	recordTestPass,
	resetGateFailure,
	shouldSkipGate,
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

describe("session-state: getGatedExtensions with gate.extensions", () => {
	it("uses gate extensions when provided", () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: {
					lint: {
						command: "biome check {file}",
						extensions: [".ts", ".tsx", ".vue"],
					},
				},
			}),
		);
		const exts = getGatedExtensions();
		expect(exts.has(".ts")).toBe(true);
		expect(exts.has(".vue")).toBe(true);
		// .css would come from TOOL_EXTS fallback for biome, but gate.extensions overrides
		expect(exts.has(".css")).toBe(false);
	});

	it("falls back to TOOL_EXTS when extensions not provided", () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "biome check {file}" } },
			}),
		);
		const exts = getGatedExtensions();
		expect(exts.has(".ts")).toBe(true);
		expect(exts.has(".tsx")).toBe(true);
		expect(exts.has(".css")).toBe(true);
	});

	it("combines gate.extensions and TOOL_EXTS fallback across gates", () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: {
					lint: {
						command: "biome check {file}",
						extensions: [".ts", ".vue"],
					},
					typecheck: { command: "tsc --noEmit" },
				},
			}),
		);
		const exts = getGatedExtensions();
		// lint gate: explicit .ts, .vue
		expect(exts.has(".vue")).toBe(true);
		// typecheck gate: TOOL_EXTS fallback for tsc
		expect(exts.has(".tsx")).toBe(true);
		expect(exts.has(".mts")).toBe(true);
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

describe("session-state: taskVerifyResults", () => {
	it("recordTaskVerifyResult and readTaskVerifyResult round-trip", () => {
		recordTaskVerifyResult("Task 1", true);
		const result = readTaskVerifyResult("Task 1");
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
		expect(result!.ran_at).toBeTruthy();
	});

	it("readTaskVerifyResult returns null for unrecorded task", () => {
		expect(readTaskVerifyResult("Task 99")).toBeNull();
	});

	it("recordTaskVerifyResult overwrites previous result", () => {
		recordTaskVerifyResult("Task 1", true);
		recordTaskVerifyResult("Task 1", false);
		const result = readTaskVerifyResult("Task 1");
		expect(result!.passed).toBe(false);
	});

	it("clearOnCommit resets task_verify_results", () => {
		recordTaskVerifyResult("Task 1", true);
		recordTaskVerifyResult("Task 2", false);
		clearOnCommit();
		expect(readTaskVerifyResult("Task 1")).toBeNull();
		expect(readTaskVerifyResult("Task 2")).toBeNull();
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
});
