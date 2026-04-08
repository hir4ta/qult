import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveGates } from "../../gates/load.ts";
import {
	closeDb,
	ensureSession,
	getDb,
	getSessionId,
	setProjectPath,
	setSessionScope,
	useTestDb,
} from "../../state/db.ts";
import { resetAllCaches } from "../../state/flush.ts";
import { writePendingFixes } from "../../state/pending-fixes.ts";
import {
	disableGate,
	recordChangedFile,
	recordReviewIteration,
} from "../../state/session-state.ts";
import type { PendingFix } from "../../types.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-post-compact");

let stdoutCapture: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
	resetAllCaches();
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
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
	closeDb();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("post-compact handler", () => {
	it("outputs pending fixes summary to stdout", async () => {
		const fixes: PendingFix[] = [
			{ file: "/src/foo.ts", errors: ["err1", "err2"], gate: "lint" },
			{ file: "/src/bar.ts", errors: ["err3"], gate: "typecheck" },
		];
		writePendingFixes(fixes);

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
		writePendingFixes(fixes);

		const postCompact = (await import("../post-compact.ts")).default;
		await postCompact({ hook_event_name: "PostCompact" });

		const output = stdoutCapture.join("");
		expect(output).toContain("Missing semicolon at line 5");
		expect(output).toContain("Type error: expected string");
		// Now shows up to 3 errors per file (improved from 1)
		expect(output).toContain("extra error");
	});

	it("injects review findings from DB (Task 8)", async () => {
		const db = getDb();
		const sid = getSessionId();
		const { getProjectId } = await import("../../state/db.ts");
		const projectId = getProjectId();
		db.prepare(
			"INSERT INTO review_findings (session_id, project_id, file, severity, description, stage) VALUES (?, ?, ?, ?, ?, ?)",
		).run(sid, projectId, "src/a.ts", "high", "SQL injection risk in query builder", "Security");
		db.prepare(
			"INSERT INTO review_findings (session_id, project_id, file, severity, description, stage) VALUES (?, ?, ?, ?, ?, ?)",
		).run(sid, projectId, "src/b.ts", "medium", "Missing input validation", "Spec");

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
		const { recordTestPass } = await import("../../state/session-state.ts");
		recordTestPass("vitest run");
		recordChangedFile("/src/a.ts");
		recordChangedFile("/src/b.ts");
		recordChangedFile("/src/c.ts");

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
		disableGate("lint");
		disableGate("review");

		const postCompact = (await import("../post-compact.ts")).default;
		await postCompact({ hook_event_name: "PostCompact" });

		const output = stdoutCapture.join("");
		expect(output).toContain("disabled gates: lint, review");
	});

	it("includes review iteration in session summary", async () => {
		recordReviewIteration(30);
		recordReviewIteration(32);

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
		saveGates({ on_commit: { test: { command: "vitest run" } } });
		resetAllCaches();
		recordChangedFile("a.ts");

		const postCompact = (await import("../post-compact.ts")).default;
		await postCompact({ hook_event_name: "PostCompact" });

		const output = stdoutCapture.join("");
		expect(output).toContain("tests: NOT PASSED");
		expect(output).toContain("review: NOT DONE");
	});

	it("fail-open on errors", async () => {
		closeDb();
		const postCompact = (await import("../post-compact.ts")).default;
		await expect(postCompact({ hook_event_name: "PostCompact" })).resolves.not.toThrow();
	});
});
