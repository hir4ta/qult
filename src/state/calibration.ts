import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-write.ts";

const STATE_DIR = ".qult/.state";
const FILE = "calibration.json";
const RECALIBRATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Defaults
const DEFAULT_PACE_FILES = 15;
const DEFAULT_REVIEW_THRESHOLD = 5;
const DEFAULT_CONTEXT_BUDGET = 2000;
const DEFAULT_LOC_LIMIT = 200;
const DEFAULT_PLAN_TASK_THRESHOLD = 3;
const DEFAULT_REVIEW_SCORE_THRESHOLD = 12;

export interface Calibration {
	pace_files: number;
	review_file_threshold: number;
	context_budget: number;
	loc_limit: number;
	plan_task_threshold: number;
	review_score_threshold: number;
	calibrated_at: string;
}

/** Input subset from MetricsSummary needed for calibration. */
export interface CalibrationInput {
	firstPassRate: number;
	firstPassTotal: number;
	reviewMiss: number;
	reviewTotal: number;
	respondSkipped: number;
	respond: number;
	avgFixEffort: number;
	fixEffortTotal: number;
	planAvgCompliance: number;
	planComplianceTotal: number;
}

/** Linear interpolation: map metric from [low, high] range to [minVal, maxVal]. */
export function lerp(
	metric: number,
	low: number,
	high: number,
	minVal: number,
	maxVal: number,
): number {
	if (metric <= low) return minVal;
	if (metric >= high) return maxVal;
	const t = (metric - low) / (high - low);
	return Math.round(minVal + t * (maxVal - minVal));
}

function filePath(): string {
	return join(process.cwd(), STATE_DIR, FILE);
}

/** Read calibration from disk. Returns null if not found or corrupt. */
export function readCalibration(): Calibration | null {
	try {
		const path = filePath();
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

/** Write calibration to disk (atomic). */
export function writeCalibration(cal: Calibration): void {
	atomicWriteJson(filePath(), cal);
}

/** Check if recalibration is due (>24h since last). */
export function shouldRecalibrate(): boolean {
	const cal = readCalibration();
	if (!cal) return true;
	const elapsed = Date.now() - new Date(cal.calibrated_at).getTime();
	return elapsed >= RECALIBRATE_INTERVAL_MS;
}

/** Get a single calibrated value, falling back to provided default. */
export function getCalibrated(
	key: keyof Omit<Calibration, "calibrated_at">,
	fallback: number,
): number {
	try {
		const cal = readCalibration();
		if (cal && typeof cal[key] === "number" && cal[key] > 0) return cal[key];
	} catch {
		/* fail-open */
	}
	return fallback;
}

/** Cold start: heuristic defaults when insufficient metrics data. */
export function coldStartDefaults(): Partial<Calibration> {
	try {
		const gatesPath = join(process.cwd(), ".qult", "gates.json");
		if (!existsSync(gatesPath)) return {};
		const gates = JSON.parse(readFileSync(gatesPath, "utf-8"));
		const gateCount =
			Object.keys(gates?.on_write ?? {}).length +
			Object.keys(gates?.on_commit ?? {}).length +
			Object.keys(gates?.on_review ?? {}).length;
		if (gateCount >= 4) return { pace_files: 10, loc_limit: 150 }; // strict project
	} catch {
		/* fail-open */
	}
	return {};
}

/** Compute calibrated thresholds from metrics summary.
 * Uses graduated lerp interpolation instead of binary thresholds. */
export function calibrate(input: CalibrationInput): Calibration {
	const isColdStart = input.firstPassTotal < 10;

	// Rule 1: pace_files — graduated on first-pass rate (40-90% → 10-25 files)
	let paceFiles: number;
	if (isColdStart) {
		paceFiles = coldStartDefaults().pace_files ?? DEFAULT_PACE_FILES;
	} else {
		paceFiles = lerp(input.firstPassRate, 40, 90, 10, 25);
	}

	// Rule 2: review_file_threshold — graduated on review-miss rate (0-10% → 7-3 files)
	let reviewThreshold: number;
	if (input.reviewTotal < 5) {
		reviewThreshold = DEFAULT_REVIEW_THRESHOLD;
	} else {
		const missRate = (input.reviewMiss / input.reviewTotal) * 100;
		reviewThreshold = lerp(missRate, 0, 10, 7, 3);
	}

	// Rule 3: context_budget — graduated on respond-skipped rate (0-30% → 1500-2500)
	const totalRespond = input.respond + input.respondSkipped;
	let contextBudget: number;
	if (totalRespond < 10) {
		contextBudget = DEFAULT_CONTEXT_BUDGET;
	} else {
		const skipRate = (input.respondSkipped / totalRespond) * 100;
		contextBudget = lerp(skipRate, 0, 30, 1500, 2500);
	}

	// Rule 4: loc_limit — graduated on fix effort (1-4 avg edits → 250-150 lines)
	let locLimit: number;
	if (isColdStart) {
		locLimit = coldStartDefaults().loc_limit ?? DEFAULT_LOC_LIMIT;
	} else if (input.fixEffortTotal < 3) {
		locLimit = DEFAULT_LOC_LIMIT;
	} else {
		locLimit = lerp(input.avgFixEffort, 1, 4, 250, 150);
	}

	// Rule 5: plan_task_threshold — graduated on plan compliance (50-90 score → 2-5 tasks)
	let planTaskThreshold: number;
	if (input.planComplianceTotal < 3) {
		planTaskThreshold = DEFAULT_PLAN_TASK_THRESHOLD;
	} else {
		planTaskThreshold = lerp(input.planAvgCompliance, 50, 90, 2, 5);
	}

	// Rule 6: review_score_threshold — graduated on review-miss rate (0-15% → 12-14)
	// 0% miss = keep default, high miss rate = raise threshold (reviews too lenient)
	let reviewScoreThreshold: number;
	if (input.reviewTotal < 5) {
		reviewScoreThreshold = DEFAULT_REVIEW_SCORE_THRESHOLD;
	} else {
		const missRate = (input.reviewMiss / input.reviewTotal) * 100;
		reviewScoreThreshold = lerp(missRate, 0, 15, DEFAULT_REVIEW_SCORE_THRESHOLD, 14);
	}

	return {
		pace_files: paceFiles,
		review_file_threshold: reviewThreshold,
		context_budget: contextBudget,
		loc_limit: locLimit,
		plan_task_threshold: planTaskThreshold,
		review_score_threshold: reviewScoreThreshold,
		calibrated_at: new Date().toISOString(),
	};
}
