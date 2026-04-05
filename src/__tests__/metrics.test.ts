import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-metrics-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

import type { SessionMetrics } from "../state/metrics.ts";
import {
	detectRecurringPatterns,
	readMetricsHistory,
	recordSessionMetrics,
} from "../state/metrics.ts";

describe("recordSessionMetrics", () => {
	it("records session metrics", () => {
		recordSessionMetrics(TEST_DIR, {
			session_id: "s1",
			timestamp: "2026-01-01T00:00:00Z",
			gate_failures: 3,
			security_warnings: 1,
			review_score: 36,
			files_changed: 5,
		});

		const history = readMetricsHistory(TEST_DIR);
		expect(history).toHaveLength(1);
		expect(history[0]!.session_id).toBe("s1");
		expect(history[0]!.gate_failures).toBe(3);
	});

	it("appends to existing history", () => {
		recordSessionMetrics(TEST_DIR, {
			session_id: "s1",
			timestamp: "2026-01-01T00:00:00Z",
			gate_failures: 1,
			security_warnings: 0,
			review_score: null,
			files_changed: 2,
		});
		recordSessionMetrics(TEST_DIR, {
			session_id: "s2",
			timestamp: "2026-01-02T00:00:00Z",
			gate_failures: 0,
			security_warnings: 0,
			review_score: 38,
			files_changed: 8,
		});

		const history = readMetricsHistory(TEST_DIR);
		expect(history).toHaveLength(2);
	});

	it("trims to 50 entries", () => {
		const existing: SessionMetrics[] = Array.from({ length: 50 }, (_, i) => ({
			session_id: `s${i}`,
			timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
			gate_failures: 0,
			security_warnings: 0,
			review_score: null,
			files_changed: 1,
		}));
		writeFileSync(join(STATE_DIR, "metrics-history.json"), JSON.stringify(existing));

		recordSessionMetrics(TEST_DIR, {
			session_id: "s50",
			timestamp: "2026-03-01T00:00:00Z",
			gate_failures: 5,
			security_warnings: 2,
			review_score: 30,
			files_changed: 10,
		});

		const history = readMetricsHistory(TEST_DIR);
		expect(history).toHaveLength(50);
		expect(history[history.length - 1]!.session_id).toBe("s50");
	});
});

describe("readMetricsHistory", () => {
	it("returns empty on missing file", () => {
		const history = readMetricsHistory(TEST_DIR);
		expect(history).toEqual([]);
	});

	it("returns empty on corrupt data", () => {
		writeFileSync(join(STATE_DIR, "metrics-history.json"), "not json {{");
		const history = readMetricsHistory(TEST_DIR);
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

	it("emits warning for frequent gate failures (4/5 sessions)", () => {
		const history: SessionMetrics[] = [
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
		];
		writeFileSync(join(STATE_DIR, "metrics-history.json"), JSON.stringify(history));

		detectRecurringPatterns(TEST_DIR);
		expect(stderrCapture.some((w) => w.includes("gate failure"))).toBe(true);
	});

	it("does not warn when failures are infrequent (2/5 sessions)", () => {
		const history: SessionMetrics[] = [
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
		];
		writeFileSync(join(STATE_DIR, "metrics-history.json"), JSON.stringify(history));

		detectRecurringPatterns(TEST_DIR);
		expect(stderrCapture.some((w) => w.includes("gate failure"))).toBe(false);
	});

	it("does not warn with fewer than 5 sessions", () => {
		const history: SessionMetrics[] = [
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
		];
		writeFileSync(join(STATE_DIR, "metrics-history.json"), JSON.stringify(history));

		detectRecurringPatterns(TEST_DIR);
		expect(stderrCapture).toHaveLength(0);
	});

	it("is fail-open on missing file", () => {
		// Should not throw
		expect(() => detectRecurringPatterns(TEST_DIR)).not.toThrow();
	});

	it("emits warning for frequent security warnings", () => {
		const history: SessionMetrics[] = [
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
		];
		writeFileSync(join(STATE_DIR, "metrics-history.json"), JSON.stringify(history));

		detectRecurringPatterns(TEST_DIR);
		expect(stderrCapture.some((w) => w.includes("security warning"))).toBe(true);
	});
});
