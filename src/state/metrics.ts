import { getDb, getProjectId } from "./db.ts";

export interface SessionMetrics {
	session_id: string;
	timestamp: string;
	gate_failures: number;
	security_warnings: number;
	review_score: number | null;
	files_changed: number;
}

const MAX_ENTRIES = 50;

/** Record session metrics to history. Fail-open. */
export function recordSessionMetrics(metrics: SessionMetrics): void {
	try {
		const db = getDb();
		const projectId = getProjectId();

		db.prepare(
			`INSERT INTO session_metrics (session_id, project_id, gate_failure_count, security_warning_count, review_aggregate, files_changed)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run(
			metrics.session_id,
			projectId,
			metrics.gate_failures,
			metrics.security_warnings,
			metrics.review_score,
			metrics.files_changed,
		);

		// Trim oldest entries beyond max for this project
		db.prepare(
			`DELETE FROM session_metrics WHERE project_id = ? AND id NOT IN (
				SELECT id FROM session_metrics WHERE project_id = ? ORDER BY id DESC LIMIT ?
			)`,
		).run(projectId, projectId, MAX_ENTRIES);
	} catch {
		/* fail-open */
	}
}

/** Read metrics history. Returns empty array on any error. */
export function readMetricsHistory(): SessionMetrics[] {
	try {
		const db = getDb();
		const projectId = getProjectId();
		const rows = db
			.prepare(
				`SELECT session_id, recorded_at, gate_failure_count, security_warning_count, review_aggregate, files_changed
				 FROM session_metrics WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
			)
			.all(projectId, MAX_ENTRIES) as {
			session_id: string;
			recorded_at: string;
			gate_failure_count: number;
			security_warning_count: number;
			review_aggregate: number | null;
			files_changed: number;
		}[];
		return rows.map((r) => ({
			session_id: r.session_id,
			timestamp: r.recorded_at,
			gate_failures: r.gate_failure_count,
			security_warnings: r.security_warning_count,
			review_score: r.review_aggregate,
			files_changed: r.files_changed,
		}));
	} catch {
		return [];
	}
}

/** Detect recurring patterns across last 5 sessions. Emits stderr warnings. Fail-open. */
export function detectRecurringPatterns(): void {
	try {
		const history = readMetricsHistory();
		if (history.length < 5) return;

		const recent = history.slice(-5);

		const gateFailSessions = recent.filter((s) => s.gate_failures > 0).length;
		if (gateFailSessions >= 4) {
			const totalGateFailures = recent.reduce((sum, s) => sum + s.gate_failures, 0);
			const avgFailures = (totalGateFailures / recent.length).toFixed(1);
			process.stderr.write(
				`[qult] Pattern: gate failures in ${gateFailSessions}/5 recent sessions (avg ${avgFailures}/session). Review toolchain or add .claude/rules/ entries.\n`,
			);
		}

		const secWarnSessions = recent.filter((s) => s.security_warnings > 0).length;
		if (secWarnSessions >= 4) {
			const totalSecWarnings = recent.reduce((sum, s) => sum + s.security_warnings, 0);
			process.stderr.write(
				`[qult] Pattern: ${totalSecWarnings} security warnings across ${secWarnSessions}/5 recent sessions. Consider adding .claude/rules/ for security patterns.\n`,
			);
		}
	} catch {
		/* fail-open */
	}
}
