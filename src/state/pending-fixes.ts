import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingFix } from "../types.ts";
import { atomicWriteJson } from "./atomic-write.ts";

const STATE_DIR = ".qult/.state";
const FIXES_FILE = "pending-fixes.json";

// Process-scoped cache
let _cache: PendingFix[] | null = null;
let _dirty = false;

function fixesPath(): string {
	return join(process.cwd(), STATE_DIR, FIXES_FILE);
}

/** Read current pending fixes. Returns empty array on any error (fail-open). */
export function readPendingFixes(): PendingFix[] {
	if (_cache) return _cache;
	try {
		const path = fixesPath();
		if (!existsSync(path)) {
			_cache = [];
			return _cache;
		}
		const raw = readFileSync(path, "utf-8");
		_cache = JSON.parse(raw);
		return _cache!;
	} catch {
		_cache = [];
		return _cache;
	}
}

/** Write pending fixes to state file (cache only — flushed at end of hook). */
export function writePendingFixes(fixes: PendingFix[]): void {
	_cache = fixes;
	_dirty = true;
}

/** Flush cached fixes to disk if dirty. */
export function flush(): void {
	if (!_dirty || !_cache) return;
	try {
		atomicWriteJson(fixesPath(), _cache);
	} catch (e) {
		if (e instanceof Error) process.stderr.write(`[qult] write error: ${e.message}\n`);
	}
	_dirty = false;
}

/** Reset cache (for tests). */
export function resetCache(): void {
	_cache = null;
	_dirty = false;
}
