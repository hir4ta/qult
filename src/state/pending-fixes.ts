import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingFix } from "../types.ts";
import { atomicWriteJson } from "./atomic-write.ts";

const STATE_DIR = ".qult/.state";
const FIXES_FILE = "pending-fixes.json";

// Process-scoped cache
let _cache: PendingFix[] | null = null;
let _dirty = false;

// Session-scoped file path: pending-fixes-{sessionId}.json
let _sessionScope: string | null = null;

/** Set session scope for pending-fixes file isolation. */
export function setFixesSessionScope(sessionId: string): void {
	_sessionScope = sessionId;
}

function fixesPath(): string {
	const file = _sessionScope ? `pending-fixes-${_sessionScope}.json` : FIXES_FILE;
	return join(process.cwd(), STATE_DIR, file);
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

/** Add pending fixes for a file, replacing any existing fixes for that file. */
export function addPendingFixes(file: string, newFixes: PendingFix[]): void {
	const existing = readPendingFixes().filter((f) => f.file !== file);
	writePendingFixes([...existing, ...newFixes]);
}

/** Remove all pending fixes for a specific file. */
export function clearPendingFixesForFile(file: string): void {
	const current = readPendingFixes();
	const remaining = current.filter((f) => f.file !== file);
	if (remaining.length !== current.length) {
		writePendingFixes(remaining);
	}
}

/** Clear all pending fixes. */
export function clearAllPendingFixes(): void {
	writePendingFixes([]);
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
	_sessionScope = null;
}
