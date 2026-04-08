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

import { DEFAULTS, type QultConfig } from "../config.ts";
import type { SessionMetrics } from "../state/metrics.ts";
import {
	analyzePatterns,
	detectRecurringPatterns,
	getFlywheelRecommendations,
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

	it("records and reads back all extended metrics fields", () => {
		createSession("s-ext");
		recordSessionMetrics({
			session_id: "s-ext",
			timestamp: "2026-04-01T00:00:00Z",
			gate_failures: 7,
			security_warnings: 3,
			review_score: 42,
			files_changed: 12,
			test_quality_warnings: 4,
			duplication_warnings: 2,
			semantic_warnings: 5,
			drift_warnings: 1,
			escalation_hit: true,
		});

		const history = readMetricsHistory();
		expect(history).toHaveLength(1);
		const m = history[0]!;
		expect(m.session_id).toBe("s-ext");
		expect(m.gate_failures).toBe(7);
		expect(m.security_warnings).toBe(3);
		expect(m.review_score).toBe(42);
		expect(m.files_changed).toBe(12);
		expect(m.test_quality_warnings).toBe(4);
		expect(m.duplication_warnings).toBe(2);
		expect(m.semantic_warnings).toBe(5);
		expect(m.drift_warnings).toBe(1);
		expect(m.escalation_hit).toBe(true);
	});

	it("defaults new fields to 0/false when not provided", () => {
		createSession("s-compat");
		recordSessionMetrics({
			session_id: "s-compat",
			timestamp: "2026-04-02T00:00:00Z",
			gate_failures: 1,
			security_warnings: 0,
			review_score: null,
			files_changed: 3,
		});

		const history = readMetricsHistory();
		expect(history).toHaveLength(1);
		const m = history[0]!;
		expect(m.session_id).toBe("s-compat");
		expect(m.gate_failures).toBe(1);
		expect(m.test_quality_warnings).toBe(0);
		expect(m.duplication_warnings).toBe(0);
		expect(m.semantic_warnings).toBe(0);
		expect(m.drift_warnings).toBe(0);
		expect(m.escalation_hit).toBe(false);
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

// ── analyzePatterns ─────────────────────────────────────────

describe("analyzePatterns", () => {
	function makeSession(id: string, overrides: Partial<SessionMetrics> = {}): SessionMetrics {
		return {
			session_id: id,
			timestamp: `2026-01-01T00:00:00Z`,
			gate_failures: 0,
			security_warnings: 0,
			review_score: null,
			files_changed: 1,
			test_quality_warnings: 0,
			duplication_warnings: 0,
			semantic_warnings: 0,
			drift_warnings: 0,
			escalation_hit: false,
			...overrides,
		};
	}

	it("5 sessions with increasing gate_failures → short window trend = worsening", () => {
		// DESC order (newest first) as returned by readMetricsHistory
		const history: SessionMetrics[] = [
			makeSession("s5", { gate_failures: 5 }),
			makeSession("s4", { gate_failures: 4 }),
			makeSession("s3", { gate_failures: 3 }),
			makeSession("s2", { gate_failures: 2 }),
			makeSession("s1", { gate_failures: 1 }),
		];
		const analyses = analyzePatterns(history);
		const gf = analyses.find((a) => a.metric === "gate_failures");
		expect(gf).toBeDefined();
		expect(gf!.windows.short).not.toBeNull();
		expect(gf!.windows.short!.trend).toBe("worsening");
		expect(gf!.windows.short!.sessionCount).toBe(5);
	});

	it("10 sessions with decreasing security_warnings → medium window trend = improving", () => {
		// DESC order: newest (lowest) first
		const history: SessionMetrics[] = [];
		for (let i = 10; i >= 1; i--) {
			history.push(makeSession(`s${i}`, { security_warnings: 11 - i }));
		}
		// history[0] = s10 (security_warnings=1), history[9] = s1 (security_warnings=10)
		// After reversal: oldest first → s1(10), s2(9), ..., s10(1) = decreasing = improving
		const analyses = analyzePatterns(history);
		const sw = analyses.find((a) => a.metric === "security_warnings");
		expect(sw).toBeDefined();
		expect(sw!.windows.medium).not.toBeNull();
		expect(sw!.windows.medium!.trend).toBe("improving");
		expect(sw!.windows.medium!.sessionCount).toBe(10);
	});

	it("insufficient sessions for a window returns null", () => {
		const history: SessionMetrics[] = [
			makeSession("s3", { gate_failures: 1 }),
			makeSession("s2", { gate_failures: 2 }),
			makeSession("s1", { gate_failures: 3 }),
		];
		const analyses = analyzePatterns(history);
		const gf = analyses.find((a) => a.metric === "gate_failures");
		expect(gf).toBeDefined();
		expect(gf!.windows.short).toBeNull();
		expect(gf!.windows.medium).toBeNull();
		expect(gf!.windows.long).toBeNull();
	});

	it("zero-count sessions correctly excluded from intensity calculation", () => {
		// 5 sessions: 3 have gate_failures > 0, 2 have 0
		const history: SessionMetrics[] = [
			makeSession("s5", { gate_failures: 6 }),
			makeSession("s4", { gate_failures: 0 }),
			makeSession("s3", { gate_failures: 3 }),
			makeSession("s2", { gate_failures: 0 }),
			makeSession("s1", { gate_failures: 3 }),
		];
		const analyses = analyzePatterns(history);
		const gf = analyses.find((a) => a.metric === "gate_failures");
		expect(gf).toBeDefined();
		expect(gf!.windows.short).not.toBeNull();
		// frequency: 3/5 = 0.6
		expect(gf!.windows.short!.frequency).toBe(0.6);
		// intensity: avg of non-zero = (3+3+6)/3 = 4
		expect(gf!.windows.short!.intensity).toBe(4);
	});

	it("returns analysis for all 6 metric types", () => {
		const history: SessionMetrics[] = [];
		for (let i = 5; i >= 1; i--) {
			history.push(makeSession(`s${i}`, { gate_failures: 1, security_warnings: 1 }));
		}
		const analyses = analyzePatterns(history);
		const metricNames = analyses.map((a) => a.metric).sort();
		expect(metricNames).toEqual([
			"drift_warnings",
			"duplication_warnings",
			"gate_failures",
			"security_warnings",
			"semantic_warnings",
			"test_quality_warnings",
		]);
	});
});

// ── getFlywheelRecommendations ──────────────────────────────

describe("getFlywheelRecommendations", () => {
	function makeSession(id: string, overrides: Partial<SessionMetrics> = {}): SessionMetrics {
		return {
			session_id: id,
			timestamp: `2026-01-01T00:00:00Z`,
			gate_failures: 0,
			security_warnings: 0,
			review_score: null,
			files_changed: 1,
			test_quality_warnings: 0,
			duplication_warnings: 0,
			semantic_warnings: 0,
			drift_warnings: 0,
			escalation_hit: false,
			...overrides,
		};
	}

	function makeConfig(overrides: Partial<QultConfig> = {}): QultConfig {
		return structuredClone({ ...DEFAULTS, ...overrides });
	}

	it("high-recurrence (>80%) worsening pattern → lower recommendation", () => {
		// 10 sessions, all with security_warnings, increasing (worsening)
		const history: SessionMetrics[] = [];
		for (let i = 10; i >= 1; i--) {
			history.push(makeSession(`s${i}`, { security_warnings: i }));
		}
		const config = makeConfig();
		config.flywheel.min_sessions = 5;
		const recs = getFlywheelRecommendations(history, config);
		const secRec = recs.find((r) => r.metric === "security");
		expect(secRec).toBeDefined();
		expect(secRec!.direction).toBe("lower");
		expect(secRec!.suggested_threshold).toBeLessThan(secRec!.current_threshold);
		expect(secRec!.suggested_threshold).toBeGreaterThanOrEqual(1);
	});

	it("low-recurrence (<20%) stable pattern → raise recommendation", () => {
		// 20 sessions. Medium window (last 10) has 0 warnings → frequency=0, trend=stable
		// Long window (all 20) has 2 warnings in first 10 → frequency=0.1 < 0.2
		// Stats uses medium window (frequency=0, stable), long window exists → qualifies
		const history: SessionMetrics[] = [];
		for (let i = 20; i >= 1; i--) {
			// After reversal: s1..s20. s3 and s7 have warnings (in first 10 only)
			const sw = i === 3 || i === 7 ? 1 : 0;
			history.push(makeSession(`s${i}`, { security_warnings: sw }));
		}
		const config = makeConfig();
		config.flywheel.min_sessions = 5;
		const recs = getFlywheelRecommendations(history, config);
		const secRec = recs.find((r) => r.metric === "security");
		expect(secRec).toBeDefined();
		expect(secRec!.direction).toBe("raise");
		expect(secRec!.suggested_threshold).toBeGreaterThan(secRec!.current_threshold);
	});

	it("returns empty when flywheel.enabled = false", () => {
		const history: SessionMetrics[] = [];
		for (let i = 10; i >= 1; i--) {
			history.push(makeSession(`s${i}`, { security_warnings: i }));
		}
		const config = makeConfig();
		config.flywheel.enabled = false;
		const recs = getFlywheelRecommendations(history, config);
		expect(recs).toEqual([]);
	});

	it("returns empty when insufficient sessions", () => {
		const history: SessionMetrics[] = [makeSession("s1", { security_warnings: 5 })];
		const config = makeConfig();
		config.flywheel.min_sessions = 10;
		const recs = getFlywheelRecommendations(history, config);
		expect(recs).toEqual([]);
	});

	it("never suggests threshold below 1", () => {
		// All sessions with security_warnings, worsening, and current threshold is already low (2)
		const history: SessionMetrics[] = [];
		for (let i = 10; i >= 1; i--) {
			history.push(makeSession(`s${i}`, { security_warnings: i }));
		}
		const config = makeConfig();
		config.flywheel.min_sessions = 5;
		config.escalation.security_threshold = 2;
		const recs = getFlywheelRecommendations(history, config);
		const secRec = recs.find((r) => r.metric === "security");
		expect(secRec).toBeDefined();
		// With threshold=2, floor(2*0.7)=1. Should still be >= 1
		expect(secRec!.suggested_threshold).toBeGreaterThanOrEqual(1);
	});
});

describe("getFlywheelRecommendations — long window guard for raise", () => {
	function makeSession(id: string, overrides: Partial<SessionMetrics> = {}): SessionMetrics {
		return {
			session_id: id,
			timestamp: "2026-01-01T00:00:00Z",
			gate_failures: 0,
			security_warnings: 0,
			review_score: null,
			files_changed: 1,
			test_quality_warnings: 0,
			duplication_warnings: 0,
			semantic_warnings: 0,
			drift_warnings: 0,
			escalation_hit: false,
			...overrides,
		};
	}

	function makeConfig(overrides: Partial<QultConfig> = {}): QultConfig {
		return structuredClone({ ...DEFAULTS, ...overrides });
	}

	it("does NOT raise when long window shows high frequency even if medium shows low", () => {
		// 20 sessions DESC. First 10 (oldest) have high security_warnings (7/10 = 70%)
		// Last 10 (newest) have low (1/10 = 10%)
		// Medium window (last 10): freq=0.1 < 0.2, trend=stable → would raise without fix
		// Long window (all 20): freq=8/20=0.4 > 0.2 → should NOT raise
		const history: SessionMetrics[] = [];
		for (let i = 20; i >= 1; i--) {
			// i=20..11 are newest (low occurrence), i=10..1 are oldest (high occurrence)
			const sw = i <= 10 && i !== 2 && i !== 5 ? 1 : 0; // 8 warnings in oldest 10
			history.push(makeSession(`s${i}`, { security_warnings: sw }));
		}
		const config = makeConfig();
		config.flywheel.min_sessions = 5;
		const recs = getFlywheelRecommendations(history, config);
		const secRec = recs.find((r) => r.metric === "security");
		// Long window has freq=0.4 > 0.2 → raise guard prevents recommendation
		expect(secRec?.direction).not.toBe("raise");
	});
});
