import type { PendingFix } from "../types.ts";
import { ensureSession, getDb, getSessionId } from "./db.ts";

// Process-scoped cache
let _cache: PendingFix[] | null = null;
let _dirty = false;

/** Read current pending fixes. Returns empty array on any error (fail-open). */
export function readPendingFixes(): PendingFix[] {
	if (_cache) return _cache;
	try {
		const db = getDb();
		const sid = getSessionId();
		ensureSession();
		const rows = db
			.prepare("SELECT file, gate, errors FROM pending_fixes WHERE session_id = ?")
			.all(sid) as { file: string; gate: string; errors: string }[];
		_cache = rows.map((r) => ({
			file: r.file,
			gate: r.gate,
			errors: JSON.parse(r.errors) as string[],
		}));
		return _cache;
	} catch {
		_cache = [];
		return _cache;
	}
}

/** Write pending fixes (cache only — flushed at end of hook). */
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

/** Flush cached fixes to DB if dirty. */
export function flush(): void {
	if (!_dirty || !_cache) return;
	try {
		const db = getDb();
		const sid = getSessionId();

		db.exec("BEGIN");
		try {
			db.prepare("DELETE FROM pending_fixes WHERE session_id = ?").run(sid);
			const insert = db.prepare(
				"INSERT INTO pending_fixes (session_id, file, gate, errors) VALUES (?, ?, ?, ?)",
			);
			for (const fix of _cache) {
				insert.run(sid, fix.file, fix.gate, JSON.stringify(fix.errors));
			}
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
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
