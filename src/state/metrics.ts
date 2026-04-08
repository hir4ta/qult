import type { QultConfig } from "../config.ts";
import { getDb, getProjectId } from "./db.ts";

export interface SessionMetrics {
	session_id: string;
	timestamp: string;
	gate_failures: number;
	security_warnings: number;
	review_score: number | null;
	files_changed: number;
	test_quality_warnings?: number;
	duplication_warnings?: number;
	semantic_warnings?: number;
	drift_warnings?: number;
	escalation_hit?: boolean;
}

const MAX_ENTRIES = 50;

/** Record session metrics to history. Fail-open. */
export function recordSessionMetrics(metrics: SessionMetrics): void {
	try {
		const db = getDb();
		const projectId = getProjectId();

		db.prepare(
			`INSERT INTO session_metrics (session_id, project_id, gate_failure_count, security_warning_count, review_aggregate, files_changed, test_quality_warning_count, duplication_warning_count, semantic_warning_count, drift_warning_count, escalation_hit)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			metrics.session_id,
			projectId,
			metrics.gate_failures,
			metrics.security_warnings,
			metrics.review_score,
			metrics.files_changed,
			metrics.test_quality_warnings ?? 0,
			metrics.duplication_warnings ?? 0,
			metrics.semantic_warnings ?? 0,
			metrics.drift_warnings ?? 0,
			metrics.escalation_hit ? 1 : 0,
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
				`SELECT session_id, recorded_at, gate_failure_count, security_warning_count, review_aggregate, files_changed, test_quality_warning_count, duplication_warning_count, semantic_warning_count, drift_warning_count, escalation_hit
				 FROM session_metrics WHERE project_id = ? ORDER BY id DESC LIMIT ?`,
			)
			.all(projectId, MAX_ENTRIES) as {
			session_id: string;
			recorded_at: string;
			gate_failure_count: number;
			security_warning_count: number;
			review_aggregate: number | null;
			files_changed: number;
			test_quality_warning_count: number;
			duplication_warning_count: number;
			semantic_warning_count: number;
			drift_warning_count: number;
			escalation_hit: number;
		}[];
		return rows.map((r) => ({
			session_id: r.session_id,
			timestamp: r.recorded_at,
			gate_failures: r.gate_failure_count,
			security_warnings: r.security_warning_count,
			review_score: r.review_aggregate,
			files_changed: r.files_changed,
			test_quality_warnings: r.test_quality_warning_count ?? 0,
			duplication_warnings: r.duplication_warning_count ?? 0,
			semantic_warnings: r.semantic_warning_count ?? 0,
			drift_warnings: r.drift_warning_count ?? 0,
			escalation_hit: !!(r.escalation_hit ?? 0),
		}));
	} catch {
		return [];
	}
}

// ── Multi-window pattern analysis ──────────────────────────

export interface WindowStats {
	frequency: number; // sessions with issues / total (0-1)
	intensity: number; // avg count per session when non-zero
	trend: "improving" | "worsening" | "stable";
	sessionCount: number;
}

export interface MetricAnalysis {
	metric: string;
	windows: {
		short: WindowStats | null; // 5 sessions
		medium: WindowStats | null; // 10 sessions
		long: WindowStats | null; // 20 sessions
	};
}

const METRIC_KEYS: (keyof SessionMetrics)[] = [
	"gate_failures",
	"security_warnings",
	"test_quality_warnings",
	"duplication_warnings",
	"semantic_warnings",
	"drift_warnings",
];

const WINDOW_SIZES = [5, 10, 20] as const;

function computeWindowStats(values: number[]): WindowStats {
	const total = values.length;
	const nonZero = values.filter((v) => v > 0);
	const frequency = nonZero.length / total;
	const intensity =
		nonZero.length > 0 ? nonZero.reduce((sum, v) => sum + v, 0) / nonZero.length : 0;

	// Trend: compare first half avg vs second half avg
	const mid = Math.floor(total / 2);
	const firstHalf = values.slice(0, mid);
	const secondHalf = values.slice(mid);
	const avgFirst = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
	const avgSecond = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
	const diff = avgSecond - avgFirst;
	const threshold = Math.max(0.1, avgFirst * 0.1);
	const trend: WindowStats["trend"] =
		diff > threshold ? "worsening" : diff < -threshold ? "improving" : "stable";

	return { frequency, intensity, trend, sessionCount: total };
}

/** Pure function: analyze 6 metrics across 3 time windows. History is DESC (newest first). */
export function analyzePatterns(history: SessionMetrics[]): MetricAnalysis[] {
	// Reverse to chronological order (oldest first)
	const chronological = [...history].reverse();

	return METRIC_KEYS.map((metric) => {
		const windows: MetricAnalysis["windows"] = { short: null, medium: null, long: null };
		const windowEntries: [keyof typeof windows, number][] = [
			["short", WINDOW_SIZES[0]],
			["medium", WINDOW_SIZES[1]],
			["long", WINDOW_SIZES[2]],
		];
		for (const [key, size] of windowEntries) {
			if (chronological.length >= size) {
				const slice = chronological.slice(-size);
				const values = slice.map((s) => (s[metric] as number) ?? 0);
				windows[key] = computeWindowStats(values);
			}
		}
		return { metric, windows };
	});
}

// ── Flywheel recommendation engine ─────────────────────────

export interface FlywheelRecommendation {
	metric: string;
	current_threshold: number;
	suggested_threshold: number;
	direction: "lower" | "raise";
	confidence: "low" | "medium" | "high";
	reason: string;
}

const METRIC_TO_THRESHOLD: Record<string, { key: keyof QultConfig["escalation"]; name: string }> = {
	security_warnings: { key: "security_threshold", name: "security" },
	test_quality_warnings: { key: "test_quality_threshold", name: "test quality" },
	duplication_warnings: { key: "duplication_threshold", name: "duplication" },
	semantic_warnings: { key: "semantic_threshold", name: "semantic" },
	drift_warnings: { key: "drift_threshold", name: "drift" },
};

export function getFlywheelRecommendations(
	history: SessionMetrics[],
	config: QultConfig,
): FlywheelRecommendation[] {
	if (!config.flywheel.enabled) return [];
	if (history.length < config.flywheel.min_sessions) return [];

	const analyses = analyzePatterns(history);
	const recs: FlywheelRecommendation[] = [];

	for (const analysis of analyses) {
		const mapping = METRIC_TO_THRESHOLD[analysis.metric];
		if (!mapping) continue; // gate_failures has no threshold

		const currentThreshold = config.escalation[mapping.key];
		// Use medium window if available, else short
		const stats = analysis.windows.medium ?? analysis.windows.short;
		if (!stats) continue;

		const confidence: FlywheelRecommendation["confidence"] = analysis.windows.long
			? "high"
			: analysis.windows.medium
				? "medium"
				: "low";

		if (stats.frequency > 0.8 && stats.trend === "worsening") {
			const suggested = Math.max(1, Math.floor(currentThreshold * 0.7));
			if (suggested < currentThreshold) {
				recs.push({
					metric: mapping.name,
					current_threshold: currentThreshold,
					suggested_threshold: suggested,
					direction: "lower",
					confidence,
					reason: `${mapping.name} warnings in ${(stats.frequency * 100).toFixed(0)}% of sessions with worsening trend`,
				});
			}
		} else if (
			stats.frequency < 0.2 &&
			stats.trend === "stable" &&
			analysis.windows.long &&
			// Also verify the long-term frequency is low — not just the medium window
			analysis.windows.long.frequency < 0.2
		) {
			const suggested = Math.min(currentThreshold + 3, currentThreshold * 2, 100);
			if (suggested > currentThreshold) {
				recs.push({
					metric: mapping.name,
					current_threshold: currentThreshold,
					suggested_threshold: Math.floor(suggested),
					direction: "raise",
					confidence,
					reason: `${mapping.name} warnings in only ${(stats.frequency * 100).toFixed(0)}% of sessions, stable over ${stats.sessionCount} sessions`,
				});
			}
		}
	}

	return recs;
}

/** Detect recurring patterns across last 5 sessions. Emits stderr warnings. Fail-open. */
export function detectRecurringPatterns(): void {
	try {
		const history = readMetricsHistory();
		if (history.length < 5) return;

		const recent = history.slice(0, 5);

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
