import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectRecurringPatterns, recordSessionMetrics } from "../state/metrics.ts";
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
			try {
				const cwd = ev.cwd ?? process.cwd();
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
					recordSessionMetrics(cwd, {
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
					});
				}
				detectRecurringPatterns(cwd);
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

		markSessionStartCompleted();
	} catch {
		/* fail-open */
	}
}
