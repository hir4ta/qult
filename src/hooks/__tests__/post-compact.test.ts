import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";
import type { PendingFix } from "../../types.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-post-compact");
const QULT_DIR = join(TEST_DIR, ".qult");
const STATE_DIR = join(QULT_DIR, ".state");
const originalCwd = process.cwd();

let stdoutCapture: string[] = [];

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stdoutCapture = [];

	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("post-compact handler", () => {
	it("outputs pending fixes summary to stdout", async () => {
		const fixes: PendingFix[] = [
			{ file: "/src/foo.ts", errors: ["err1", "err2"], gate: "lint" },
			{ file: "/src/bar.ts", errors: ["err3"], gate: "typecheck" },
		];
		writeFileSync(join(STATE_DIR, "pending-fixes.json"), JSON.stringify(fixes));

		const postCompact = (await import("../post-compact.ts")).default;
		await postCompact({ hook_event_name: "PostCompact" });

		const output = stdoutCapture.join("");
		expect(output).toContain("2 pending fix(es)");
		expect(output).toContain("/src/foo.ts");
		expect(output).toContain("/src/bar.ts");
	});

	it("includes first error detail per pending fix (Task 8)", async () => {
		const fixes: PendingFix[] = [
			{ file: "/src/foo.ts", errors: ["Missing semicolon at line 5", "extra error"], gate: "lint" },
			{ file: "/src/bar.ts", errors: ["Type error: expected string"], gate: "typecheck" },
		];
		writeFileSync(join(STATE_DIR, "pending-fixes.json"), JSON.stringify(fixes));

		const postCompact = (await import("../post-compact.ts")).default;
		await postCompact({ hook_event_name: "PostCompact" });

		const output = stdoutCapture.join("");
		expect(output).toContain("Missing semicolon at line 5");
		expect(output).toContain("Type error: expected string");
		// Now shows up to 3 errors per file (improved from 1)
		expect(output).toContain("extra error");
	});

	it("injects review findings from review-findings-history.json (Task 8)", async () => {
		const findings = [
			{
				file: "src/a.ts",
				severity: "high",
				description: "SQL injection risk in query builder",
				stage: "Security",
				timestamp: "2026-01-01T00:00:00Z",
			},
			{
				file: "src/b.ts",
				severity: "medium",
				description: "Missing input validation",
				stage: "Spec",
				timestamp: "2026-01-02T00:00:00Z",
			},
		];
		writeFileSync(join(STATE_DIR, "review-findings-history.json"), JSON.stringify(findings));

		const postCompact = (await import("../post-compact.ts")).default;
		await postCompact({ hook_event_name: "PostCompact" });

		const output = stdoutCapture.join("");
		expect(output).toContain("Recent review findings");
		expect(output).toContain("SQL injection risk");
		expect(output).toContain("Missing input validation");
		expect(output).toContain("[high]");
		expect(output).toContain("[medium]");
	});

	it("outputs session state summary to stdout", async () => {
		const state = {
			test_passed_at: "2026-03-31T00:00:00Z",
			review_completed_at: null,
			changed_file_paths: ["/src/a.ts", "/src/b.ts", "/src/c.ts"],
		};
		writeFileSync(join(STATE_DIR, "session-state.json"), JSON.stringify(state));

		const postCompact = (await import("../post-compact.ts")).default;
		await postCompact({ hook_event_name: "PostCompact" });

		const output = stdoutCapture.join("");
		expect(output).toContain("test_passed_at");
		expect(output).toContain("3 file(s) changed");
	});

	it("outputs nothing when no state exists", async () => {
		const postCompact = (await import("../post-compact.ts")).default;
		await postCompact({ hook_event_name: "PostCompact" });

		const output = stdoutCapture.join("");
		expect(output).toBe("");
	});

	it("includes disabled gates in session summary", async () => {
		const state = {
			disabled_gates: ["lint", "review"],
			changed_file_paths: [],
		};
		writeFileSync(join(STATE_DIR, "session-state.json"), JSON.stringify(state));

		const postCompact = (await import("../post-compact.ts")).default;
		await postCompact({ hook_event_name: "PostCompact" });

		const output = stdoutCapture.join("");
		expect(output).toContain("disabled gates: lint, review");
	});

	it("includes review iteration in session summary", async () => {
		const state = {
			review_iteration: 2,
			changed_file_paths: [],
		};
		writeFileSync(join(STATE_DIR, "session-state.json"), JSON.stringify(state));

		const postCompact = (await import("../post-compact.ts")).default;
		await postCompact({ hook_event_name: "PostCompact" });

		const output = stdoutCapture.join("");
		expect(output).toContain("review iteration: 2");
	});

	it("includes plan task progress", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Do A [done]",
				"### Task 2: Do B [done]",
				"### Task 3: Do C [pending]",
			].join("\n"),
		);

		const postCompact = (await import("../post-compact.ts")).default;
		await postCompact({ hook_event_name: "PostCompact" });

		const output = stdoutCapture.join("");
		expect(output).toContain("Plan: 2/3 tasks done");
	});

	it("includes NOT PASSED / NOT DONE when tests and review are incomplete", async () => {
		// Requires gates.json to exist for NOT PASSED/NOT DONE to show
		writeFileSync(
			join(QULT_DIR, "gates.json"),
			JSON.stringify({ on_commit: { test: { command: "vitest run" } } }),
		);
		const state = {
			test_passed_at: null,
			review_completed_at: null,
			changed_file_paths: ["a.ts"],
		};
		writeFileSync(join(STATE_DIR, "session-state.json"), JSON.stringify(state));

		const postCompact = (await import("../post-compact.ts")).default;
		await postCompact({ hook_event_name: "PostCompact" });

		const output = stdoutCapture.join("");
		expect(output).toContain("tests: NOT PASSED");
		expect(output).toContain("review: NOT DONE");
	});

	it("fail-open on errors", async () => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		const postCompact = (await import("../post-compact.ts")).default;
		await expect(postCompact({ hook_event_name: "PostCompact" })).resolves.not.toThrow();
	});
});
