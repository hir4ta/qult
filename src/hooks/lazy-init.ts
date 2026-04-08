import { writePendingFixes } from "../state/pending-fixes.ts";

let _initialized = false;
let _sessionStartCompleted = false;

/** Mark that SessionStart hook has completed. Called by session-start handler. */
export function markSessionStartCompleted(): void {
	_sessionStartCompleted = true;
}

/** Check if SessionStart hook has completed. */
export function isSessionStartCompleted(): boolean {
	return _sessionStartCompleted;
}

/**
 * Lazy initialization: fallback for when SessionStart hook does not fire.
 * Called at the start of every dispatch(), idempotent.
 *
 * - Skipped if SessionStart already ran
 * - Clears pending-fixes for fresh session start
 */
export function lazyInit(): void {
	if (_sessionStartCompleted) return;
	if (_initialized) return;
	_initialized = true;

	try {
		writePendingFixes([]);
	} catch {
		/* fail-open */
	}
}

/** Reset for testing. */
export function resetLazyInit(): void {
	_initialized = false;
	_sessionStartCompleted = false;
}
