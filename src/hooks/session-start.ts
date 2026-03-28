import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadGates } from "../gates/load.ts";
import {
	type Calibration,
	calibrate,
	readCalibration,
	shouldRecalibrate,
	writeCalibration,
} from "../state/calibration.ts";
import { runProviders } from "../state/context-providers.ts";
import { migrateIfNeeded } from "../state/daily-file.ts";
import { getCommitStats, getTopErrors } from "../state/gate-history.ts";
import { getMetricsSummary } from "../state/metrics.ts";
import { writePendingFixes } from "../state/pending-fixes.ts";
import { readSessionState } from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { respond } from "./respond.ts";

/** SessionStart: ensure .qult/ exists, prompt gate detection if empty, inject error trends */
export default async function sessionStart(_ev: HookEvent): Promise<void> {
	const qultDir = join(process.cwd(), ".qult");
	const stateDir = join(qultDir, ".state");
	if (!existsSync(stateDir)) {
		mkdirSync(stateDir, { recursive: true });
	}
	// Ensure daily rotation directories exist
	mkdirSync(join(qultDir, "metrics"), { recursive: true });
	mkdirSync(join(qultDir, "gate-history"), { recursive: true });

	// Auto-migrate old single-file state to daily rotation
	try {
		migrateIfNeeded(join(stateDir, "metrics.json"), "metrics");
		migrateIfNeeded(join(stateDir, "gate-history.json"), "gate-history");
	} catch {
		/* fail-open */
	}

	// Clear stale pending-fixes from previous session.
	// Gates will re-detect issues when files are edited in this session.
	writePendingFixes([]);

	// Prompt gate detection if gates are empty
	const gates = loadGates();
	const hasGates =
		gates &&
		(Object.keys(gates.on_write ?? {}).length > 0 ||
			Object.keys(gates.on_commit ?? {}).length > 0 ||
			Object.keys(gates.on_review ?? {}).length > 0);
	if (!hasGates) {
		respond(
			"Gates are not configured. Run /qult:detect-gates to auto-detect your project's lint, typecheck, and test tools.",
		);
		return;
	}

	// Auto-calibrate thresholds based on accumulated metrics
	try {
		if (shouldRecalibrate()) {
			const commitStats = getCommitStats();
			const summary = getMetricsSummary(
				readSessionState().peak_consecutive_error_count,
				commitStats?.count ?? 0,
			);
			const prev = readCalibration();
			const cal = calibrate({
				firstPassRate: summary.firstPassRate,
				firstPassTotal: summary.firstPassTotal,
				reviewMiss: summary.reviewMiss,
				reviewTotal: summary.reviewTotal,
				respondSkipped: summary.respondSkipped,
				respond: summary.respond,
				avgFixEffort: summary.avgFixEffort,
				fixEffortTotal: summary.fixEffortTotal,
			});
			writeCalibration(cal);
			logCalibrationChanges(prev, cal);
		}
	} catch {
		/* fail-open */
	}

	// Gather session context: error trends + external providers
	const contextParts: string[] = [];

	const topErrors = getTopErrors(3);
	if (topErrors.length > 0) {
		const errorLines = topErrors.map((e) => `- ${e.gate}: "${e.error}" (${e.count}x)`);
		contextParts.push(`Frequent errors:\n${errorLines.join("\n")}\nAvoid these patterns.`);
	}

	try {
		const providerResults = runProviders("session_start");
		if (providerResults.length > 0) {
			contextParts.push(`Project context:\n${providerResults.join("\n")}`);
		}
	} catch {
		/* fail-open */
	}

	if (contextParts.length > 0) {
		respond(contextParts.join("\n\n"));
	}
}

const CAL_KEYS: (keyof Omit<Calibration, "calibrated_at">)[] = [
	"pace_files",
	"review_file_threshold",
	"context_budget",
	"loc_limit",
];

function logCalibrationChanges(prev: Calibration | null, next: Calibration): void {
	const changes: string[] = [];
	for (const key of CAL_KEYS) {
		const oldVal = prev?.[key] ?? null;
		if (oldVal !== null && oldVal !== next[key]) {
			changes.push(`${key} ${oldVal}→${next[key]}`);
		}
	}
	if (changes.length > 0) {
		process.stderr.write(`[qult] Calibrated: ${changes.join(", ")}\n`);
	} else if (!prev) {
		process.stderr.write("[qult] Initial calibration complete.\n");
	}
}
