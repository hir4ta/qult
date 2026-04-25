/**
 * Cache reset utility for tests.
 *
 * Pre-v1.0 this also flushed session-state and pending-fixes write caches
 * to SQLite. Since v1.0 those modules write directly to JSON files (no
 * batching), so flush is a no-op and we only reset the config cache.
 */

import { resetConfigCache } from "../config.ts";

/** Flush dirty caches. v1.0 has nothing to flush. */
export function flushAll(): void {
	// no-op: file-based state writes synchronously.
}

/** Reset in-process caches (for tests). */
export function resetAllCaches(): void {
	resetConfigCache();
}
