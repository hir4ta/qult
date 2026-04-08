import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeDb,
	ensureSession,
	getDb,
	getProjectId,
	setProjectPath,
	setSessionScope,
	useTestDb,
} from "../state/db.ts";

const TEST_DIR = "/tmp/.tmp-metrics-test";

function createSession(sessionId: string): void {
	const db = getDb();
	const projectId = getProjectId();
	db.prepare("INSERT OR IGNORE INTO sessions (id, project_id) VALUES (?, ?)").run(
		sessionId,
		projectId,
	);
}

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
});

afterEach(() => {
	vi.restoreAllMocks();
	closeDb();
});

import type { SessionMetrics } from "../state/metrics.ts";
import {
	detectRecurringPatterns,
	readMetricsHistory,
	recordSessionMetrics,
} from "../state/metrics.ts";

describe("recordSessionMetrics", () => {
	it("records session metrics", () => {
		createSession("s1");
		recordSessionMetrics({
			session_id: "s1",
			timestamp: "2026-01-01T00:00:00Z",
			gate_failures: 3,
			security_warnings: 1,
			review_score: 36,
			files_changed: 5,
		});

		const history = readMetricsHistory();
		expect(history).toHaveLength(1);
		expect(history[0]!.session_id).toBe("s1");
		expect(history[0]!.gate_failures).toBe(3);
	});

	it("appends to existing history", () => {
		createSession("s1");
		createSession("s2");
		recordSessionMetrics({
			session_id: "s1",
			timestamp: "2026-01-01T00:00:00Z",
			gate_failures: 1,
			security_warnings: 0,
			review_score: null,
			files_changed: 2,
		});
		recordSessionMetrics({
			session_id: "s2",
			timestamp: "2026-01-02T00:00:00Z",
			gate_failures: 0,
			security_warnings: 0,
			review_score: 38,
			files_changed: 8,
		});

		const history = readMetricsHistory();
		expect(history).toHaveLength(2);
	});

	it("trims to 50 entries", () => {
		for (let i = 0; i <= 50; i++) {
			createSession(`s${i}`);
		}
		for (let i = 0; i < 50; i++) {
			recordSessionMetrics({
				session_id: `s${i}`,
				timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
				gate_failures: 0,
				security_warnings: 0,
				review_score: null,
				files_changed: 1,
			});
		}

		recordSessionMetrics({
			session_id: "s50",
			timestamp: "2026-03-01T00:00:00Z",
			gate_failures: 5,
			security_warnings: 2,
			review_score: 30,
			files_changed: 10,
		});

		const history = readMetricsHistory();
		expect(history).toHaveLength(50);
		// Newest first (DESC order)
		expect(history[0]!.session_id).toBe("s50");
	});
});

describe("readMetricsHistory", () => {
	it("returns empty on no entries", () => {
		const history = readMetricsHistory();
		expect(history).toEqual([]);
	});
});

describe("detectRecurringPatterns", () => {
	let stderrCapture: string[] = [];

	beforeEach(() => {
		stderrCapture = [];
		vi.spyOn(process.stderr, "write").mockImplementation((data) => {
			stderrCapture.push(typeof data === "string" ? data : data.toString());
			return true;
		});
	});

	function insertMetrics(metrics: SessionMetrics[]): void {
		for (const m of metrics) {
			createSession(m.session_id);
			recordSessionMetrics(m);
		}
	}

	it("emits warning for frequent gate failures (4/5 sessions)", () => {
		insertMetrics([
			{
				session_id: "s1",
				timestamp: "t1",
				gate_failures: 3,
				security_warnings: 0,
				review_score: null,
				files_changed: 2,
			},
			{
				session_id: "s2",
				timestamp: "t2",
				gate_failures: 1,
				security_warnings: 0,
				review_score: null,
				files_changed: 3,
			},
			{
				session_id: "s3",
				timestamp: "t3",
				gate_failures: 0,
				security_warnings: 0,
				review_score: null,
				files_changed: 1,
			},
			{
				session_id: "s4",
				timestamp: "t4",
				gate_failures: 2,
				security_warnings: 0,
				review_score: null,
				files_changed: 5,
			},
			{
				session_id: "s5",
				timestamp: "t5",
				gate_failures: 4,
				security_warnings: 0,
				review_score: null,
				files_changed: 4,
			},
		]);

		detectRecurringPatterns();
		expect(stderrCapture.some((w) => w.includes("gate failure"))).toBe(true);
	});

	it("does not warn when failures are infrequent (2/5 sessions)", () => {
		insertMetrics([
			{
				session_id: "s1",
				timestamp: "t1",
				gate_failures: 1,
				security_warnings: 0,
				review_score: null,
				files_changed: 2,
			},
			{
				session_id: "s2",
				timestamp: "t2",
				gate_failures: 0,
				security_warnings: 0,
				review_score: null,
				files_changed: 3,
			},
			{
				session_id: "s3",
				timestamp: "t3",
				gate_failures: 0,
				security_warnings: 0,
				review_score: null,
				files_changed: 1,
			},
			{
				session_id: "s4",
				timestamp: "t4",
				gate_failures: 2,
				security_warnings: 0,
				review_score: null,
				files_changed: 5,
			},
			{
				session_id: "s5",
				timestamp: "t5",
				gate_failures: 0,
				security_warnings: 0,
				review_score: null,
				files_changed: 4,
			},
		]);

		detectRecurringPatterns();
		expect(stderrCapture.some((w) => w.includes("gate failure"))).toBe(false);
	});

	it("does not warn with fewer than 5 sessions", () => {
		insertMetrics([
			{
				session_id: "s1",
				timestamp: "t1",
				gate_failures: 5,
				security_warnings: 3,
				review_score: null,
				files_changed: 2,
			},
			{
				session_id: "s2",
				timestamp: "t2",
				gate_failures: 3,
				security_warnings: 2,
				review_score: null,
				files_changed: 3,
			},
		]);

		detectRecurringPatterns();
		expect(stderrCapture).toHaveLength(0);
	});

	it("is fail-open on empty data", () => {
		expect(() => detectRecurringPatterns()).not.toThrow();
	});

	it("emits warning for frequent security warnings", () => {
		insertMetrics([
			{
				session_id: "s1",
				timestamp: "t1",
				gate_failures: 0,
				security_warnings: 2,
				review_score: null,
				files_changed: 2,
			},
			{
				session_id: "s2",
				timestamp: "t2",
				gate_failures: 0,
				security_warnings: 1,
				review_score: null,
				files_changed: 3,
			},
			{
				session_id: "s3",
				timestamp: "t3",
				gate_failures: 0,
				security_warnings: 3,
				review_score: null,
				files_changed: 1,
			},
			{
				session_id: "s4",
				timestamp: "t4",
				gate_failures: 0,
				security_warnings: 1,
				review_score: null,
				files_changed: 5,
			},
			{
				session_id: "s5",
				timestamp: "t5",
				gate_failures: 0,
				security_warnings: 0,
				review_score: null,
				files_changed: 4,
			},
		]);

		detectRecurringPatterns();
		expect(stderrCapture.some((w) => w.includes("security warning"))).toBe(true);
	});
});
