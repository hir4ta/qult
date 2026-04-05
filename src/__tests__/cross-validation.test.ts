import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-cross-validation-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
const PLANS_DIR = join(TEST_DIR, ".claude", "plans");
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

import { crossValidate } from "../hooks/subagent-stop/cross-validation.ts";

describe("crossValidate", () => {
	it("detects security contradiction: reviewer says no issues but detector found some", () => {
		// Write pending-fixes with security-check gate
		writeFileSync(
			join(STATE_DIR, "pending-fixes.json"),
			JSON.stringify([
				{ file: "src/foo.ts", errors: ["L10: Hardcoded API key"], gate: "security-check" },
			]),
		);
		resetAllCaches();

		const output = "Security: PASS\nScore: Vulnerability=5 Hardening=5\nNo issues found";
		const result = crossValidate(output, "Security");
		expect(result.contradictions.length).toBeGreaterThan(0);
		expect(result.contradictions[0]).toContain("security-check");
	});

	it("detects spec contradiction: reviewer says complete but plan has pending tasks", () => {
		mkdirSync(PLANS_DIR, { recursive: true });
		writeFileSync(
			join(PLANS_DIR, "plan-test.md"),
			[
				"## Tasks",
				"### Task 1: Implement foo [done]",
				"- **File**: src/foo.ts",
				"### Task 2: Implement bar [pending]",
				"- **File**: src/bar.ts",
			].join("\n"),
		);

		const output = "Spec: PASS\nScore: Completeness=5 Accuracy=5\nAll tasks complete";
		const result = crossValidate(output, "Spec");
		expect(result.contradictions.length).toBeGreaterThan(0);
		expect(result.contradictions[0]).toContain("pending");
	});

	it("detects quality contradiction: high scores but dead-import warnings", () => {
		writeFileSync(
			join(STATE_DIR, "session-state.json"),
			JSON.stringify({ dead_import_warning_count: 5 }),
		);
		resetAllCaches();

		const output = "Quality: PASS\nScore: Design=5 Maintainability=5\nNo issues found";
		const result = crossValidate(output, "Quality");
		expect(result.contradictions.length).toBeGreaterThan(0);
		expect(result.contradictions[0]).toContain("dead-import");
	});

	it("returns no contradictions when states align", () => {
		writeFileSync(join(STATE_DIR, "pending-fixes.json"), JSON.stringify([]));
		writeFileSync(join(STATE_DIR, "session-state.json"), JSON.stringify({}));
		resetAllCaches();

		const output = "Security: PASS\nScore: Vulnerability=5 Hardening=5\nNo issues found";
		const result = crossValidate(output, "Security");
		expect(result.contradictions).toEqual([]);
	});

	it("is fail-open on missing state files", () => {
		// crossValidate reads state via process.cwd(), so missing state = empty = no contradictions
		const result = crossValidate("Quality: PASS\nScore: Design=5 Maintainability=5", "Quality");
		expect(result.contradictions).toEqual([]);
	});

	it("does not flag security when pending-fixes are from non-security gates", () => {
		writeFileSync(
			join(STATE_DIR, "pending-fixes.json"),
			JSON.stringify([{ file: "src/foo.ts", errors: ["missing semicolon"], gate: "lint" }]),
		);
		resetAllCaches();

		const output = "Security: PASS\nScore: Vulnerability=5 Hardening=5\nNo issues found";
		const result = crossValidate(output, "Security");
		expect(result.contradictions).toEqual([]);
	});
});
