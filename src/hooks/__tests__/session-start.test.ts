import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";
import { readPendingFixes } from "../../state/pending-fixes.ts";
import type { PendingFix } from "../../types.ts";
import { resetLazyInit } from "../lazy-init.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-session-start");
const QULT_DIR = join(TEST_DIR, ".qult");
const STATE_DIR = join(QULT_DIR, ".state");
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	resetLazyInit();
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);

	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("session-start handler", () => {
	it("creates .qult/.state/ directory if missing", async () => {
		rmSync(STATE_DIR, { recursive: true, force: true });
		const sessionStart = (await import("../session-start.ts")).default;

		await sessionStart({ hook_event_name: "SessionStart", source: "startup" } as never);

		expect(existsSync(STATE_DIR)).toBe(true);
	});

	it("clears pending-fixes on startup source", async () => {
		const fixes: PendingFix[] = [{ file: "/src/foo.ts", errors: ["err"], gate: "lint" }];
		writeFileSync(join(STATE_DIR, "pending-fixes.json"), JSON.stringify(fixes));
		resetAllCaches();

		const sessionStart = (await import("../session-start.ts")).default;
		await sessionStart({ hook_event_name: "SessionStart", source: "startup" } as never);

		resetAllCaches();
		const remaining = readPendingFixes();
		expect(remaining).toEqual([]);
	});

	it("clears pending-fixes on clear source", async () => {
		const fixes: PendingFix[] = [{ file: "/src/foo.ts", errors: ["err"], gate: "lint" }];
		writeFileSync(join(STATE_DIR, "pending-fixes.json"), JSON.stringify(fixes));
		resetAllCaches();

		const sessionStart = (await import("../session-start.ts")).default;
		await sessionStart({ hook_event_name: "SessionStart", source: "clear" } as never);

		resetAllCaches();
		const remaining = readPendingFixes();
		expect(remaining).toEqual([]);
	});

	it("does NOT clear pending-fixes on compact source", async () => {
		const fixes: PendingFix[] = [{ file: "/src/foo.ts", errors: ["err"], gate: "lint" }];
		writeFileSync(join(STATE_DIR, "pending-fixes.json"), JSON.stringify(fixes));
		resetAllCaches();

		const sessionStart = (await import("../session-start.ts")).default;
		await sessionStart({ hook_event_name: "SessionStart", source: "compact" } as never);

		resetAllCaches();
		const remaining = readPendingFixes();
		expect(remaining.length).toBe(1);
	});

	it("does NOT clear pending-fixes on resume source", async () => {
		const fixes: PendingFix[] = [{ file: "/src/foo.ts", errors: ["err"], gate: "lint" }];
		writeFileSync(join(STATE_DIR, "pending-fixes.json"), JSON.stringify(fixes));
		resetAllCaches();

		const sessionStart = (await import("../session-start.ts")).default;
		await sessionStart({ hook_event_name: "SessionStart", source: "resume" } as never);

		resetAllCaches();
		const remaining = readPendingFixes();
		expect(remaining.length).toBe(1);
	});

	it("cleans up stale scoped files (>24h)", async () => {
		const staleFile = join(STATE_DIR, "pending-fixes-old-session.json");
		writeFileSync(staleFile, "[]");
		const { utimesSync } = await import("node:fs");
		const pastTime = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
		utimesSync(staleFile, pastTime, pastTime);

		const sessionStart = (await import("../session-start.ts")).default;
		await sessionStart({ hook_event_name: "SessionStart", source: "startup" } as never);

		expect(existsSync(staleFile)).toBe(false);
	});

	it("sets flag so lazyInit becomes no-op", async () => {
		const sessionStart = (await import("../session-start.ts")).default;
		const { isSessionStartCompleted } = await import("../lazy-init.ts");

		await sessionStart({ hook_event_name: "SessionStart", source: "startup" } as never);

		expect(isSessionStartCompleted()).toBe(true);
	});

	it("fail-open on errors", async () => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		// Even when the base dir doesn't exist, should not throw
		const sessionStart = (await import("../session-start.ts")).default;
		await expect(
			sessionStart({ hook_event_name: "SessionStart", source: "startup" } as never),
		).resolves.not.toThrow();
	});

	it("records metrics on startup", async () => {
		// Arrange: write previous session state with gate failures
		writeFileSync(
			join(STATE_DIR, "session-state.json"),
			JSON.stringify({
				gate_failure_counts: { "src/foo.ts:lint": 2, "src/bar.ts:typecheck": 1 },
				security_warning_count: 1,
				changed_file_paths: ["src/foo.ts", "src/bar.ts"],
				review_completed_at: null,
				review_score_history: [],
			}),
		);
		resetAllCaches();

		const sessionStart = (await import("../session-start.ts")).default;
		await sessionStart({
			hook_event_name: "SessionStart",
			source: "startup",
			session_id: "test-session",
		} as never);

		const metricsPath = join(STATE_DIR, "metrics-history.json");
		expect(existsSync(metricsPath)).toBe(true);
		const history = JSON.parse(readFileSync(metricsPath, "utf-8"));
		expect(history).toHaveLength(1);
		expect(history[0].gate_failures).toBe(3);
		expect(history[0].security_warnings).toBe(1);
		expect(history[0].files_changed).toBe(2);
	});
});
