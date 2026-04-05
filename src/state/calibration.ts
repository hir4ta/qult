import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-write.ts";

const CALIBRATION_FILE = "review-calibration.json";
const MAX_ENTRIES = 50;

export interface CalibrationEntry {
	date: string;
	aggregate: number;
	stages: Record<string, Record<string, number>>;
	/** Project identifier (cwd hash). Absent in legacy entries. */
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

function calibrationPath(): string | null {
	const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
	if (!pluginDataDir) return null;
	return join(pluginDataDir, CALIBRATION_FILE);
}

/** Generate a stable project identifier from cwd. */
export function projectId(): string {
	const cwd = process.cwd();
	return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

/** Read calibration data from cross-session storage. Returns null if unavailable. */
export function readCalibration(): CalibrationData | null {
	const path = calibrationPath();
	if (!path || !existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

/** Record a review score to cross-session calibration data. */
export function recordCalibration(
	aggregate: number,
	stageScores: Record<string, Record<string, number>>,
): void {
	const path = calibrationPath();
	if (!path) return;

	const data = readCalibration() ?? {
		entries: [],
		stats: { mean: 0, stddev: 0, count: 0, perfect_count: 0 },
	};

	data.entries.push({
		date: new Date().toISOString(),
		aggregate,
		stages: stageScores,
		project: projectId(),
	});

	// Trim to max entries
	if (data.entries.length > MAX_ENTRIES) {
		data.entries = data.entries.slice(-MAX_ENTRIES);
	}

	// Recompute stats
	const scores = data.entries.map((e) => e.aggregate);
	const count = scores.length;
	const mean = scores.reduce((s, v) => s + v, 0) / count;
	const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / count;
	const stddev = Math.sqrt(variance);
	const perfectCount = data.entries.filter((e) => {
		const dims = Object.values(e.stages).flatMap((s) => Object.values(s));
		return dims.length > 0 && dims.every((v) => v === 5);
	}).length;

	data.stats = {
		mean: Math.round(mean * 100) / 100,
		stddev: Math.round(stddev * 100) / 100,
		count,
		perfect_count: perfectCount,
	};

	atomicWriteJson(path, data);
}

export interface CalibrationWarning {
	type: "high_mean" | "low_variance" | "perfect_streak";
	message: string;
}

/** Check for calibration anomalies. Returns warnings (non-blocking).
 *  Filters by current project. Legacy entries (no project field) are included in all checks. */
export function checkCalibration(): CalibrationWarning[] {
	const data = readCalibration();
	if (!data) return [];

	const currentProject = projectId();
	const projectEntries = data.entries.filter((e) => !e.project || e.project === currentProject);
	if (projectEntries.length < 5) return []; // Need minimum data

	// Recompute stats for project-scoped entries
	const scores = projectEntries.map((e) => e.aggregate);
	const count = scores.length;
	const mean = scores.reduce((s, v) => s + v, 0) / count;
	const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / count;
	const stddev = Math.sqrt(variance);

	const warnings: CalibrationWarning[] = [];

	// High mean + low variance → systematically inflated scores
	// Threshold is 93% of max observed score (dynamic for /30 or /40 scale)
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

	// Low variance alone (even with moderate mean)
	if (count >= 10 && roundedStddev < 0.8) {
		warnings.push({
			type: "low_variance",
			message: `Cross-session calibration: σ=${roundedStddev} across ${count} reviews suggests reviewers are not differentiating.`,
		});
	}

	// Perfect score streak (project-scoped)
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
