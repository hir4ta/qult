import { describe, expect, it } from "vitest";
import { generateMetricsDashboard } from "../metrics-dashboard.ts";
import type { SessionMetrics } from "../state/metrics.ts";

describe("generateMetricsDashboard", () => {
	it("generates summary from metrics history", () => {
		const metrics: SessionMetrics[] = [
			{
				session_id: "s1",
				timestamp: "2026-04-01T10:00:00Z",
				gate_failures: 3,
				security_warnings: 1,
				review_score: 35,
				files_changed: 5,
			},
			{
				session_id: "s2",
				timestamp: "2026-04-02T10:00:00Z",
				gate_failures: 0,
				security_warnings: 0,
				review_score: 38,
				files_changed: 3,
			},
			{
				session_id: "s3",
				timestamp: "2026-04-03T10:00:00Z",
				gate_failures: 2,
				security_warnings: 0,
				review_score: 34,
				files_changed: 7,
			},
		];

		const result = generateMetricsDashboard(metrics);
		expect(result).toContain("3 sessions");
		expect(result).toContain("Gate failures");
		expect(result).toContain("Review scores");
	});

	it("handles empty metrics", () => {
		const result = generateMetricsDashboard([]);
		expect(result).toContain("No metrics");
	});

	it("shows per-session breakdown", () => {
		const metrics: SessionMetrics[] = [
			{
				session_id: "s1",
				timestamp: "2026-04-01T10:00:00Z",
				gate_failures: 5,
				security_warnings: 2,
				review_score: 30,
				files_changed: 10,
			},
		];

		const result = generateMetricsDashboard(metrics);
		expect(result).toContain("5 gate failure");
		expect(result).toContain("2 security warning");
		expect(result).toContain("30/40");
	});

	it("calculates averages correctly", () => {
		const metrics: SessionMetrics[] = [
			{
				session_id: "s1",
				timestamp: "2026-04-01",
				gate_failures: 2,
				security_warnings: 0,
				review_score: 30,
				files_changed: 3,
			},
			{
				session_id: "s2",
				timestamp: "2026-04-02",
				gate_failures: 4,
				security_warnings: 0,
				review_score: 36,
				files_changed: 5,
			},
		];

		const result = generateMetricsDashboard(metrics);
		expect(result).toContain("avg 3.0 gate failures");
		expect(result).toContain("avg 33.0/40");
	});
});
