import { getDb, getProjectId, getSessionId } from "./db.ts";

const MAX_ENTRIES = 50;

export interface CalibrationEntry {
	date: string;
	aggregate: number;
	stages: Record<string, Record<string, number>>;
	project?: string;
}

export interface CalibrationData {
	entries: CalibrationEntry[];
	stats: {
		mean: number;
		stddev: number;
		count: number;
		perfect_count: number;
	};
}

/** Read calibration data from DB. Returns null if unavailable. */
export function readCalibration(): CalibrationData | null {
	try {
		const db = getDb();
		const rows = db
			.prepare(
				"SELECT aggregate, stages, recorded_at, project_id FROM calibration ORDER BY id DESC LIMIT ?",
			)
			.all(MAX_ENTRIES) as {
			aggregate: number;
			stages: string;
			recorded_at: string;
			project_id: number;
		}[];

		if (rows.length === 0) return null;

		const entries: CalibrationEntry[] = rows.reverse().map((r) => ({
			date: r.recorded_at,
			aggregate: r.aggregate,
			stages: JSON.parse(r.stages) as Record<string, Record<string, number>>,
			project: String(r.project_id),
		}));

		const scores = entries.map((e) => e.aggregate);
		const count = scores.length;
		const mean = scores.reduce((s, v) => s + v, 0) / count;
		const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / count;
		const stddev = Math.sqrt(variance);
		const perfectCount = entries.filter((e) => {
			const dims = Object.values(e.stages).flatMap((s) => Object.values(s));
			return dims.length > 0 && dims.every((v) => v === 5);
		}).length;

		return {
			entries,
			stats: {
				mean: Math.round(mean * 100) / 100,
				stddev: Math.round(stddev * 100) / 100,
				count,
				perfect_count: perfectCount,
			},
		};
	} catch {
		return null;
	}
}

/** Record a review score to calibration data. */
export function recordCalibration(
	aggregate: number,
	stageScores: Record<string, Record<string, number>>,
): void {
	try {
		const db = getDb();
		const projectId = getProjectId();
		const sid = getSessionId();

		db.prepare(
			"INSERT INTO calibration (project_id, session_id, aggregate, stages) VALUES (?, ?, ?, ?)",
		).run(projectId, sid, aggregate, JSON.stringify(stageScores));

		// Trim oldest entries beyond max, scoped to this project
		db.prepare(
			`DELETE FROM calibration WHERE project_id = ? AND id NOT IN (
				SELECT id FROM calibration WHERE project_id = ? ORDER BY id DESC LIMIT ?
			)`,
		).run(projectId, projectId, MAX_ENTRIES);
	} catch {
		/* fail-open */
	}
}

/** Generate a stable project identifier. Now returns DB project_id as string. */
export function projectId(): string {
	return String(getProjectId());
}

export interface CalibrationWarning {
	type: "high_mean" | "low_variance" | "perfect_streak";
	message: string;
}

/** Check for calibration anomalies. Returns warnings (non-blocking). */
export function checkCalibration(): CalibrationWarning[] {
	const data = readCalibration();
	if (!data) return [];

	const currentProject = projectId();
	const projectEntries = data.entries.filter((e) => !e.project || e.project === currentProject);

	if (projectEntries.length > 0 && projectEntries.length < 3) {
		return [
			{
				type: "low_variance" as const,
				message: `Cross-session calibration: only ${projectEntries.length} review(s) recorded for this project. Scores may not be reliable yet.`,
			},
		];
	}
	if (projectEntries.length < 5) return [];

	const scores = projectEntries.map((e) => e.aggregate);
	const count = scores.length;
	const mean = scores.reduce((s, v) => s + v, 0) / count;
	const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / count;
	const stddev = Math.sqrt(variance);

	const warnings: CalibrationWarning[] = [];

	const maxObserved = Math.max(...scores, 1);
	const highMeanThreshold = maxObserved * 0.93;
	const roundedMean = Math.round(mean * 100) / 100;
	const roundedStddev = Math.round(stddev * 100) / 100;
	if (roundedMean > highMeanThreshold && roundedStddev < 1.5) {
		warnings.push({
			type: "high_mean",
			message: `Cross-session calibration: mean ${roundedMean} with σ=${roundedStddev} across ${count} reviews. Scores may be systematically inflated.`,
		});
	}

	if (count >= 10 && roundedStddev < 0.8) {
		warnings.push({
			type: "low_variance",
			message: `Cross-session calibration: σ=${roundedStddev} across ${count} reviews suggests reviewers are not differentiating.`,
		});
	}

	const recentEntries = projectEntries.slice(-3);
	const maxPossible = recentEntries.every((e) => {
		const dims = Object.values(e.stages).flatMap((s) => Object.values(s));
		return dims.length > 0 && dims.every((v) => v === 5);
	});
	if (maxPossible && recentEntries.length >= 3) {
		warnings.push({
			type: "perfect_streak",
			message:
				"Cross-session calibration: 3+ consecutive perfect scores. No code is perfect — reviewers may need recalibration.",
		});
	}

	return warnings;
}
