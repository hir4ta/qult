import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { emitSemgrepWarning } from "../gates/detect.ts";
import {
	detectRecurringPatterns,
	getFlywheelRecommendations,
	readMetricsHistory,
	recordSessionMetrics,
} from "../state/metrics.ts";
import { flush as flushPendingFixes, writePendingFixes } from "../state/pending-fixes.ts";
import { readSessionState } from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { markSessionStartCompleted } from "./lazy-init.ts";

let _legacyWarned = false;

/** SessionStart: record previous session metrics, optionally clear pending-fixes. */
export default async function sessionStart(ev: HookEvent): Promise<void> {
	try {
		// Legacy .qult/ directory warning (once per process)
		if (!_legacyWarned) {
			_legacyWarned = true;
			const cwd = ev.cwd ?? process.cwd();
			if (existsSync(join(cwd, ".qult"))) {
				process.stderr.write(
					"[qult] Legacy .qult/ directory detected. State is now stored in ~/.qult/qult.db. You can safely delete .qult/ from this project.\n",
				);
			}
		}
		// Only clear pending-fixes on fresh session start (not compact/resume)
		if (ev.source === "startup" || ev.source === "clear") {
			// Record metrics from previous session before clearing state
			const cfg = loadConfig();
			try {
				const prevState = readSessionState();
				const gateFailures = Object.values(prevState.gate_failure_counts ?? {}).reduce(
					(sum: number, v: unknown) => sum + (typeof v === "number" ? v : 0),
					0,
				);
				if (
					gateFailures > 0 ||
					(prevState.security_warning_count ?? 0) > 0 ||
					(prevState.changed_file_paths ?? []).length > 0
				) {
					recordSessionMetrics({
						session_id: ev.session_id ?? "unknown",
						timestamp: new Date().toISOString(),
						gate_failures: gateFailures,
						security_warnings: prevState.security_warning_count ?? 0,
						review_score: prevState.review_completed_at
							? Array.isArray(prevState.review_score_history)
								? (prevState.review_score_history.slice(-1)[0] ?? null)
								: null
							: null,
						files_changed: (prevState.changed_file_paths ?? []).length,
						test_quality_warnings: prevState.test_quality_warning_count ?? 0,
						duplication_warnings: prevState.duplication_warning_count ?? 0,
						semantic_warnings: prevState.semantic_warning_count ?? 0,
						drift_warnings: prevState.drift_warning_count ?? 0,
						escalation_hit:
							(prevState.security_warning_count ?? 0) >= cfg.escalation.security_threshold ||
							(prevState.test_quality_warning_count ?? 0) >=
								cfg.escalation.test_quality_threshold ||
							(prevState.duplication_warning_count ?? 0) >= cfg.escalation.duplication_threshold ||
							(prevState.semantic_warning_count ?? 0) >= cfg.escalation.semantic_threshold ||
							(prevState.drift_warning_count ?? 0) >= cfg.escalation.drift_threshold,
					});
				}
				detectRecurringPatterns();
			} catch {
				/* fail-open */
			}

			try {
				if (cfg.flywheel.enabled) {
					const hist = readMetricsHistory();
					const recs = getFlywheelRecommendations(hist, cfg);
					for (const rec of recs) {
						process.stderr.write(
							`[qult] Flywheel: ${rec.metric} — suggest ${rec.direction === "lower" ? "lowering" : "raising"} threshold from ${rec.current_threshold} to ${rec.suggested_threshold} (${rec.confidence} confidence). ${rec.reason}\n`,
						);
					}
				}
			} catch {
				/* fail-open */
			}

			writePendingFixes([]);
			try {
				flushPendingFixes();
			} catch {
				/* fail-open */
			}
		}

		// Semgrep installation check (once per startup)
		if (ev.source === "startup") {
			try {
				emitSemgrepWarning(ev.cwd ?? process.cwd());
			} catch {
				/* fail-open */
			}
		}

		markSessionStartCompleted();
	} catch {
		/* fail-open */
	}
}
