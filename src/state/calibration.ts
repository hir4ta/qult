import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-write.ts";

const CALIBRATION_FILE = "review-calibration.json";
const MAX_ENTRIES = 50;

export interface CalibrationEntry {
	date: string;
	aggregate: number;
	stages: Record<string, Record<string, number>>;
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
	const perfectCount = data.entries.filter((e) => e.aggregate === 30).length;

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

/** Check for calibration anomalies. Returns warnings (non-blocking). */
export function checkCalibration(): CalibrationWarning[] {
	const data = readCalibration();
	if (!data || data.stats.count < 5) return []; // Need minimum data

	const warnings: CalibrationWarning[] = [];

	// High mean + low variance → systematically inflated scores
	if (data.stats.mean > 28 && data.stats.stddev < 1.5) {
		warnings.push({
			type: "high_mean",
			message: `Cross-session calibration: mean ${data.stats.mean}/30 with σ=${data.stats.stddev} across ${data.stats.count} reviews. Scores may be systematically inflated.`,
		});
	}

	// Low variance alone (even with moderate mean)
	if (data.stats.count >= 10 && data.stats.stddev < 0.8) {
		warnings.push({
			type: "low_variance",
			message: `Cross-session calibration: σ=${data.stats.stddev} across ${data.stats.count} reviews suggests reviewers are not differentiating between codebases.`,
		});
	}

	// Perfect score streak
	const recentPerfect = data.entries.slice(-3).every((e) => e.aggregate === 30);
	if (recentPerfect && data.stats.count >= 3) {
		warnings.push({
			type: "perfect_streak",
			message:
				"Cross-session calibration: 3+ consecutive perfect scores (30/30). No code is perfect — reviewers may need recalibration.",
		});
	}

	return warnings;
}
