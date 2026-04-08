import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, ensureSession, setProjectPath, setSessionScope, useTestDb } from "../state/db.ts";
import { resetAllCaches } from "../state/flush.ts";
import { flush as flushPendingFixes, writePendingFixes } from "../state/pending-fixes.ts";
import {
	flush as flushSessionState,
	incrementEscalation,
	incrementGateFailure,
} from "../state/session-state.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-cross-validation-test");
const PLANS_DIR = join(TEST_DIR, ".claude", "plans");
let stderrCapture: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
	resetAllCaches();
	mkdirSync(TEST_DIR, { recursive: true });
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
	closeDb();
	rmSync(TEST_DIR, { recursive: true, force: true });
});

import { crossValidate } from "../hooks/subagent-stop/cross-validation.ts";

describe("crossValidate", () => {
	it("detects security contradiction: reviewer says no issues but detector found some", () => {
		writePendingFixes([
			{ file: "src/foo.ts", errors: ["L10: Hardcoded API key"], gate: "security-check" },
		]);
		flushPendingFixes();
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
		// Set dead_import_warning_count to 5 via incrementEscalation
		for (let i = 0; i < 5; i++) {
			incrementEscalation("dead_import_warning_count");
		}
		flushSessionState();
		resetAllCaches();

		const output = "Quality: PASS\nScore: Design=5 Maintainability=5\nNo issues found";
		const result = crossValidate(output, "Quality");
		expect(result.contradictions.length).toBeGreaterThan(0);
		expect(result.contradictions[0]).toContain("dead-import");
	});

	it("returns no contradictions when states align", () => {
		writePendingFixes([]);
		flushPendingFixes();
		resetAllCaches();

		const output = "Security: PASS\nScore: Vulnerability=5 Hardening=5\nNo issues found";
		const result = crossValidate(output, "Security");
		expect(result.contradictions).toEqual([]);
	});

	it("is fail-open on fresh session", () => {
		const result = crossValidate("Quality: PASS\nScore: Design=5 Maintainability=5", "Quality");
		expect(result.contradictions).toEqual([]);
	});

	it("detects spec contradiction: gate failures exist but reviewer says all complete", () => {
		// Set gate failures >= 3
		for (let i = 0; i < 3; i++) {
			incrementGateFailure("src/foo.ts", "lint");
		}
		for (let i = 0; i < 4; i++) {
			incrementGateFailure("src/bar.ts", "typecheck");
		}
		flushSessionState();
		resetAllCaches();

		const output = "Spec: PASS\nScore: Completeness=5 Accuracy=5\nAll tasks complete";
		const result = crossValidate(output, "Spec");
		expect(result.contradictions.length).toBeGreaterThan(0);
		expect(result.contradictions[0]).toContain("gate failure");
	});

	it("detects quality contradiction: test quality warnings but no issues found", () => {
		for (let i = 0; i < 5; i++) {
			incrementEscalation("test_quality_warning_count");
		}
		flushSessionState();
		resetAllCaches();

		const output = "Quality: PASS\nScore: Design=5 Maintainability=5\nNo issues found";
		const result = crossValidate(output, "Quality");
		expect(result.contradictions.length).toBeGreaterThan(0);
		expect(result.contradictions[0]).toContain("test quality");
	});

	it("detects quality contradiction: duplication warnings but no issues found", () => {
		for (let i = 0; i < 6; i++) {
			incrementEscalation("duplication_warning_count");
		}
		flushSessionState();
		resetAllCaches();

		const output = "Quality: PASS\nScore: Design=5 Maintainability=5\nNo issues found";
		const result = crossValidate(output, "Quality");
		expect(result.contradictions.length).toBeGreaterThan(0);
		expect(result.contradictions[0]).toContain("duplication");
	});

	it("does not flag security when pending-fixes are from non-security gates", () => {
		writePendingFixes([{ file: "src/foo.ts", errors: ["missing semicolon"], gate: "lint" }]);
		flushPendingFixes();
		resetAllCaches();

		const output = "Security: PASS\nScore: Vulnerability=5 Hardening=5\nNo issues found";
		const result = crossValidate(output, "Security");
		expect(result.contradictions).toEqual([]);
	});
});
