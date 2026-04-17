import { resetConfigCache } from "../config.ts";
import { flush as flushPendingFixes, resetCache as resetPendingFixes } from "./pending-fixes.ts";
import { resetPlanCache, setDisableHomeFallback } from "./plan-status.ts";
import { flush as flushSessionState, resetCache as resetSessionState } from "./session-state.ts";

/** Flush all dirty state caches to DB. Called once at end of hook dispatch. */
export function flushAll(): void {
	try {
		flushSessionState();
	} catch {
		/* fail-open */
	}
	try {
		flushPendingFixes();
	} catch {
		/* fail-open */
	}
}

/** Reset all caches (for tests). */
export function resetAllCaches(): void {
	resetSessionState();
	resetPendingFixes();
	resetPlanCache();
	resetConfigCache();
	setDisableHomeFallback(true);
}
