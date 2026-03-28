import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAllCaches } from "../state/flush.ts";
import {
	clearOnCommit,
	countGatedFiles,
	isReviewRequired,
	markGateRan,
	readSessionState,
	recordChangedFile,
	recordReview,
	recordTestPass,
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

	it("required when gated files >= 5", () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
			}),
		);
		for (let i = 0; i < 5; i++) {
			recordChangedFile(`/project/src/file${i}.ts`);
		}
		expect(isReviewRequired()).toBe(true);
	});

	it("not required when only non-gated files changed", () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
			}),
		);
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
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
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
		expect(countGatedFiles()).toBe(2);
	});

	it("returns 0 when no gates configured", () => {
		recordChangedFile("/project/src/app.ts");
		expect(countGatedFiles()).toBe(0);
	});

	it("deduplicates file paths", () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
			}),
		);
		recordChangedFile("/project/src/app.ts");
		recordChangedFile("/project/src/app.ts");
		recordChangedFile("/project/src/app.ts");
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
