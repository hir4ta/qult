/**
 * Cache reset utility for tests.
 *
 * State modules write JSON files synchronously, so there is nothing to
 * flush at runtime. The exported `flushAll` is a no-op kept for API
 * compatibility; `resetAllCaches` only resets the in-process config cache.
 */

import { resetConfigCache } from "../config.ts";

/** Flush dirty caches. No-op: state writes are synchronous. */
export function flushAll(): void {
	// no-op: file-based state writes synchronously.
}

/** Reset in-process caches (for tests). */
export function resetAllCaches(): void {
	resetConfigCache();
}
