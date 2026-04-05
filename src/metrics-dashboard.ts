import type { SessionMetrics } from "./state/metrics.ts";

/**
 * Generate a human-readable metrics dashboard from session history.
 * Pure function — takes metrics as input, returns formatted string.
 */
export function generateMetricsDashboard(metrics: SessionMetrics[]): string {
	if (metrics.length === 0) {
		return "No metrics data available yet. Metrics are recorded after each session.";
	}

	const lines: string[] = [];
	lines.push(`## Metrics Dashboard (${metrics.length} sessions)\n`);

	// Aggregates
	const totalGateFailures = metrics.reduce((sum, m) => sum + m.gate_failures, 0);
	const totalSecurityWarnings = metrics.reduce((sum, m) => sum + m.security_warnings, 0);
	const reviewScores = metrics.filter((m) => m.review_score !== null).map((m) => m.review_score!);
	const avgGateFailures = totalGateFailures / metrics.length;
	const avgReviewScore =
		reviewScores.length > 0 ? reviewScores.reduce((a, b) => a + b, 0) / reviewScores.length : null;

	lines.push("### Summary");
	lines.push(
		`- Gate failures: ${totalGateFailures} total, avg ${avgGateFailures.toFixed(1)} gate failures/session`,
	);
	lines.push(`- Security warnings: ${totalSecurityWarnings} total`);
	if (avgReviewScore !== null) {
		lines.push(
			`- Review scores: avg ${avgReviewScore.toFixed(1)}/40 across ${reviewScores.length} reviews`,
		);
	}
	lines.push("");

	// Per-session breakdown (most recent first, max 10)
	lines.push("### Recent Sessions");
	const recent = metrics.slice(-10).reverse();
	for (const m of recent) {
		const date = m.timestamp.slice(0, 10);
		const parts: string[] = [];
		if (m.gate_failures > 0) parts.push(`${m.gate_failures} gate failure(s)`);
		if (m.security_warnings > 0) parts.push(`${m.security_warnings} security warning(s)`);
		if (m.review_score !== null) parts.push(`${m.review_score}/40`);
		parts.push(`${m.files_changed} files`);
		lines.push(`- ${date}: ${parts.join(", ")}`);
	}

	return lines.join("\n");
}
