import type { AuditEntry } from "./state/audit-log.ts";
import type { SessionMetrics } from "./state/metrics.ts";

export interface HarnessRecommendation {
	type: "idle_gate" | "high_failure_rate" | "security_recurring";
	message: string;
}

export interface HarnessReport {
	totalSessions: number;
	gateFailureSessions: number;
	securityWarningSessions: number;
	averageReviewScore: number | null;
	reviewTrend: "improving" | "declining" | "stable" | "insufficient_data";
	gateDisableCount: number;
	disablesByGate: Record<string, number>;
	recommendations: HarnessRecommendation[];
}

/** Minimum sessions needed for trend analysis. */
const MIN_TREND_SESSIONS = 3;

/** Sessions without gate failures to suggest removal. */
const IDLE_GATE_THRESHOLD = 10;

/**
 * Analyze metrics history and audit log to produce a harness effectiveness report.
 * Pure function — no I/O, takes data as arguments.
 */
export function generateHarnessReport(
	metrics: SessionMetrics[],
	auditLog: AuditEntry[],
): HarnessReport {
	const recommendations: HarnessRecommendation[] = [];

	// Gate effectiveness
	const gateFailureSessions = metrics.filter((m) => m.gate_failures > 0).length;
	const securityWarningSessions = metrics.filter((m) => m.security_warnings > 0).length;

	// Review scores
	const reviewScores = metrics.filter((m) => m.review_score !== null).map((m) => m.review_score!);
	const averageReviewScore =
		reviewScores.length > 0 ? reviewScores.reduce((a, b) => a + b, 0) / reviewScores.length : null;

	// Review trend
	const reviewTrend = computeReviewTrend(reviewScores);

	// Gate disable analysis
	const disableEntries = auditLog.filter((e) => e.action === "disable_gate");
	const disablesByGate: Record<string, number> = {};
	for (const entry of disableEntries) {
		const gate = entry.gate_name ?? "unknown";
		disablesByGate[gate] = (disablesByGate[gate] ?? 0) + 1;
	}

	// Recommendations
	if (metrics.length >= IDLE_GATE_THRESHOLD && gateFailureSessions === 0) {
		recommendations.push({
			type: "idle_gate",
			message: `No gate failures in ${metrics.length} sessions. Consider reviewing if all gates are still necessary.`,
		});
	}

	if (metrics.length >= 5 && securityWarningSessions >= Math.ceil(metrics.length * 0.6)) {
		recommendations.push({
			type: "security_recurring",
			message: `Security warnings in ${securityWarningSessions}/${metrics.length} sessions. Consider adding .claude/rules/ for security patterns.`,
		});
	}

	return {
		totalSessions: metrics.length,
		gateFailureSessions,
		securityWarningSessions,
		averageReviewScore,
		reviewTrend,
		gateDisableCount: disableEntries.length,
		disablesByGate,
		recommendations,
	};
}

function computeReviewTrend(
	scores: number[],
): "improving" | "declining" | "stable" | "insufficient_data" {
	if (scores.length < MIN_TREND_SESSIONS) return "insufficient_data";

	// Use last N scores for trend
	const recent = scores.slice(-MIN_TREND_SESSIONS);
	let improving = 0;
	let declining = 0;

	for (let i = 1; i < recent.length; i++) {
		if (recent[i]! > recent[i - 1]!) improving++;
		else if (recent[i]! < recent[i - 1]!) declining++;
	}

	if (improving > declining) return "improving";
	if (declining > improving) return "declining";
	return "stable";
}
