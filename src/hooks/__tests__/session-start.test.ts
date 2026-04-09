import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeDb,
	ensureSession,
	getDb,
	getProjectId,
	setProjectPath,
	setSessionScope,
	useTestDb,
} from "../../state/db.ts";
import { flushAll, resetAllCaches } from "../../state/flush.ts";
import { readPendingFixes, writePendingFixes } from "../../state/pending-fixes.ts";
import { recordChangedFile } from "../../state/session-state.ts";
import { resetLazyInit } from "../lazy-init.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-session-start");
const originalCwd = process.cwd();

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
	resetAllCaches();
	resetLazyInit();
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
	process.chdir(TEST_DIR);

	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	closeDb();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("session-start handler", () => {
	it("clears pending-fixes on startup source", async () => {
		writePendingFixes([{ file: "/src/foo.ts", errors: ["err"], gate: "lint" }]);
		resetAllCaches();

		const sessionStart = (await import("../session-start.ts")).default;
		await sessionStart({ hook_event_name: "SessionStart", source: "startup" } as never);

		resetAllCaches();
		const remaining = readPendingFixes();
		expect(remaining).toEqual([]);
	});

	it("clears pending-fixes on clear source", async () => {
		writePendingFixes([{ file: "/src/foo.ts", errors: ["err"], gate: "lint" }]);
		resetAllCaches();

		const sessionStart = (await import("../session-start.ts")).default;
		await sessionStart({ hook_event_name: "SessionStart", source: "clear" } as never);

		resetAllCaches();
		const remaining = readPendingFixes();
		expect(remaining).toEqual([]);
	});

	it("does NOT clear pending-fixes on compact source", async () => {
		writePendingFixes([{ file: "/src/foo.ts", errors: ["err"], gate: "lint" }]);
		flushAll();
		resetAllCaches();

		const sessionStart = (await import("../session-start.ts")).default;
		await sessionStart({ hook_event_name: "SessionStart", source: "compact" } as never);

		resetAllCaches();
		const remaining = readPendingFixes();
		expect(remaining.length).toBe(1);
	});

	it("does NOT clear pending-fixes on resume source", async () => {
		writePendingFixes([{ file: "/src/foo.ts", errors: ["err"], gate: "lint" }]);
		flushAll();
		resetAllCaches();

		const sessionStart = (await import("../session-start.ts")).default;
		await sessionStart({ hook_event_name: "SessionStart", source: "resume" } as never);

		resetAllCaches();
		const remaining = readPendingFixes();
		expect(remaining.length).toBe(1);
	});

	it("sets flag so lazyInit becomes no-op", async () => {
		const sessionStart = (await import("../session-start.ts")).default;
		const { isSessionStartCompleted } = await import("../lazy-init.ts");

		await sessionStart({ hook_event_name: "SessionStart", source: "startup" } as never);

		expect(isSessionStartCompleted()).toBe(true);
	});

	it("fail-open on errors", async () => {
		closeDb();
		// Even when the DB is closed, should not throw
		const sessionStart = (await import("../session-start.ts")).default;
		await expect(
			sessionStart({ hook_event_name: "SessionStart", source: "startup" } as never),
		).resolves.not.toThrow();
	});

	it("adds semgrep-required pending-fix when semgrep not installed", async () => {
		// Restrict PATH so semgrep is not found (no node_modules/.bin/semgrep in TEST_DIR either)
		const originalPath = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			const sessionStart = (await import("../session-start.ts")).default;
			await sessionStart({
				hook_event_name: "SessionStart",
				source: "startup",
				cwd: TEST_DIR,
			} as never);

			resetAllCaches();
			const fixes = readPendingFixes();
			expect(fixes.some((f) => f.gate === "semgrep-required")).toBe(true);
			const fix = fixes.find((f) => f.gate === "semgrep-required")!;
			expect(fix.errors[0]).toContain("brew install semgrep");
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("skips semgrep check when require_semgrep is false", async () => {
		const originalPath = process.env.PATH;
		process.env.PATH = "/nonexistent";
		// Override config via env var
		process.env.QULT_REQUIRE_SEMGREP = "false";
		try {
			const { resetConfigCache } = await import("../../config.ts");
			resetConfigCache();

			const sessionStart = (await import("../session-start.ts")).default;
			await sessionStart({
				hook_event_name: "SessionStart",
				source: "startup",
				cwd: TEST_DIR,
			} as never);

			resetAllCaches();
			const fixes = readPendingFixes();
			expect(fixes.some((f) => f.gate === "semgrep-required")).toBe(false);
		} finally {
			process.env.PATH = originalPath;
			delete process.env.QULT_REQUIRE_SEMGREP;
		}
	});

	it("skips semgrep check when gate is disabled", async () => {
		const originalPath = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			// Disable the gate via DB
			const db = getDb();
			const sid = db
				.prepare("SELECT id FROM sessions WHERE project_id = ? ORDER BY rowid DESC LIMIT 1")
				.get(getProjectId()) as { id: string } | undefined;
			if (sid) {
				db.prepare(
					"INSERT OR REPLACE INTO disabled_gates (session_id, gate_name, reason) VALUES (?, ?, ?)",
				).run(sid.id, "semgrep-required", "test");
			}
			resetAllCaches();

			const sessionStart = (await import("../session-start.ts")).default;
			await sessionStart({
				hook_event_name: "SessionStart",
				source: "startup",
				cwd: TEST_DIR,
			} as never);

			resetAllCaches();
			const fixes = readPendingFixes();
			expect(fixes.some((f) => f.gate === "semgrep-required")).toBe(false);
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("records metrics on startup", async () => {
		// Arrange: populate session state with gate failures and changed files
		const { incrementGateFailure, incrementEscalation } = await import(
			"../../state/session-state.ts"
		);
		const { flushAll } = await import("../../state/flush.ts");
		incrementGateFailure("src/foo.ts", "lint");
		incrementGateFailure("src/foo.ts", "lint");
		incrementGateFailure("src/bar.ts", "typecheck");
		incrementEscalation("security_warning_count");
		recordChangedFile("src/foo.ts");
		recordChangedFile("src/bar.ts");
		flushAll();
		resetAllCaches();

		const sessionStart = (await import("../session-start.ts")).default;
		await sessionStart({
			hook_event_name: "SessionStart",
			source: "startup",
			session_id: "test-session",
		} as never);

		const db = getDb();
		const projectId = getProjectId();
		const rows = db
			.prepare("SELECT * FROM session_metrics WHERE project_id = ?")
			.all(projectId) as {
			gate_failure_count: number;
			security_warning_count: number;
			files_changed: number;
		}[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.gate_failure_count).toBe(3);
		expect(rows[0]!.security_warning_count).toBe(1);
		expect(rows[0]!.files_changed).toBe(2);
	});
});
