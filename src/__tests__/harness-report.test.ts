import { describe, expect, it } from "vitest";
import { generateHarnessReport } from "../harness-report.ts";
import type { AuditEntry } from "../state/audit-log.ts";
import type { SessionMetrics } from "../state/metrics.ts";

describe("generateHarnessReport", () => {
	it("reports gate effectiveness from metrics history", () => {
		const metrics: SessionMetrics[] = [
			{
				session_id: "s1",
				timestamp: "2026-04-01",
				gate_failures: 3,
				security_warnings: 1,
				review_score: 35,
				files_changed: 5,
			},
			{
				session_id: "s2",
				timestamp: "2026-04-02",
				gate_failures: 0,
				security_warnings: 0,
				review_score: 38,
				files_changed: 3,
			},
			{
				session_id: "s3",
				timestamp: "2026-04-03",
				gate_failures: 2,
				security_warnings: 0,
				review_score: 34,
				files_changed: 7,
			},
		];

		const report = generateHarnessReport(metrics, []);
		expect(report.totalSessions).toBe(3);
		expect(report.gateFailureSessions).toBe(2);
		expect(report.securityWarningSessions).toBe(1);
		expect(report.averageReviewScore).toBeCloseTo(35.67, 1);
	});

	it("detects idle gates from audit log disable actions", () => {
		const metrics: SessionMetrics[] = Array.from({ length: 12 }, (_, i) => ({
			session_id: `s${i}`,
			timestamp: `2026-04-${String(i + 1).padStart(2, "0")}`,
			gate_failures: 0,
			security_warnings: 0,
			review_score: null,
			files_changed: 2,
		}));

		const audit: AuditEntry[] = [
			{
				action: "disable_gate",
				gate_name: "lint",
				reason: "false positive",
				timestamp: "2026-04-05",
			},
		];

		const report = generateHarnessReport(metrics, audit);
		expect(report.recommendations).toContainEqual(expect.objectContaining({ type: "idle_gate" }));
	});

	it("detects improving review score trend", () => {
		const metrics: SessionMetrics[] = [
			{
				session_id: "s1",
				timestamp: "2026-04-01",
				gate_failures: 0,
				security_warnings: 0,
				review_score: 28,
				files_changed: 5,
			},
			{
				session_id: "s2",
				timestamp: "2026-04-02",
				gate_failures: 0,
				security_warnings: 0,
				review_score: 32,
				files_changed: 5,
			},
			{
				session_id: "s3",
				timestamp: "2026-04-03",
				gate_failures: 0,
				security_warnings: 0,
				review_score: 36,
				files_changed: 5,
			},
		];

		const report = generateHarnessReport(metrics, []);
		expect(report.reviewTrend).toBe("improving");
	});

	it("detects declining review score trend", () => {
		const metrics: SessionMetrics[] = [
			{
				session_id: "s1",
				timestamp: "2026-04-01",
				gate_failures: 0,
				security_warnings: 0,
				review_score: 38,
				files_changed: 5,
			},
			{
				session_id: "s2",
				timestamp: "2026-04-02",
				gate_failures: 0,
				security_warnings: 0,
				review_score: 34,
				files_changed: 5,
			},
			{
				session_id: "s3",
				timestamp: "2026-04-03",
				gate_failures: 0,
				security_warnings: 0,
				review_score: 30,
				files_changed: 5,
			},
		];

		const report = generateHarnessReport(metrics, []);
		expect(report.reviewTrend).toBe("declining");
	});

	it("handles empty metrics gracefully", () => {
		const report = generateHarnessReport([], []);
		expect(report.totalSessions).toBe(0);
		expect(report.recommendations).toEqual([]);
		expect(report.reviewTrend).toBe("insufficient_data");
	});

	it("counts false positive rate from disable_gate audit entries", () => {
		const audit: AuditEntry[] = [
			{
				action: "disable_gate",
				gate_name: "lint",
				reason: "false positive in config",
				timestamp: "2026-04-01",
			},
			{
				action: "disable_gate",
				gate_name: "lint",
				reason: "broken after upgrade",
				timestamp: "2026-04-02",
			},
			{
				action: "disable_gate",
				gate_name: "typecheck",
				reason: "temp issue",
				timestamp: "2026-04-03",
			},
		];

		const report = generateHarnessReport([], audit);
		expect(report.gateDisableCount).toBe(3);
		expect(report.disablesByGate.lint).toBe(2);
		expect(report.disablesByGate.typecheck).toBe(1);
	});
});
