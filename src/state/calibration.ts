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

export interface Calibration {
	pace_files: number;
	review_file_threshold: number;
	context_budget: number;
	loc_limit: number;
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

/** Compute calibrated thresholds from metrics summary. */
export function calibrate(input: CalibrationInput): Calibration {
	// Rule 1: pace_files — adjust based on first-pass clean rate
	let paceFiles = DEFAULT_PACE_FILES;
	if (input.firstPassRate > 80 && input.firstPassTotal >= 20) {
		paceFiles = 20;
	} else if (input.firstPassRate < 50 && input.firstPassTotal >= 10) {
		paceFiles = 10;
	}

	// Rule 2: review_file_threshold — tighten if reviewer miss rate exceeds 5%
	let reviewThreshold = DEFAULT_REVIEW_THRESHOLD;
	if (input.reviewTotal >= 5 && input.reviewMiss / input.reviewTotal > 0.05) {
		reviewThreshold = 3;
	}

	// Rule 3: context_budget — adjust based on respond-skipped rate
	const totalRespond = input.respond + input.respondSkipped;
	const skipRate = totalRespond > 0 ? input.respondSkipped / totalRespond : 0;
	let contextBudget = DEFAULT_CONTEXT_BUDGET;
	if (skipRate > 0.2) {
		contextBudget = 2500;
	} else if (skipRate < 0.05) {
		contextBudget = 1500;
	}

	// Rule 4: loc_limit — adjust based on fix effort
	let locLimit = DEFAULT_LOC_LIMIT;
	if (input.avgFixEffort > 3 && input.fixEffortTotal >= 3) {
		locLimit = 150;
	} else if (input.avgFixEffort < 1.5 && input.fixEffortTotal >= 5) {
		locLimit = 250;
	}

	return {
		pace_files: paceFiles,
		review_file_threshold: reviewThreshold,
		context_budget: contextBudget,
		loc_limit: locLimit,
		calibrated_at: new Date().toISOString(),
	};
}
