/**
 * Filesystem primitives for the .qult/ project-local state.
 *
 * - `atomicWrite`: writes via `<file>.tmp` + `rename` so a crash mid-write never
 *   leaves a torn file.
 * - `readJson` / `writeJson`: JSON I/O with `schema_version` checking.
 * - `ensureDir`: idempotent `mkdir -p`.
 *
 * No locking, no mtime CAS — concurrent writers are out of scope (worktree-
 * concurrent operations are explicitly out of scope per requirements.md).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertConfinedToQult } from "./paths.ts";

/** Maximum size of a single state file we are willing to read (1 MiB). */
const MAX_READ_BYTES = 1024 * 1024;

/** Idempotent `mkdir -p`. */
export function ensureDir(absPath: string): void {
	mkdirSync(absPath, { recursive: true });
}

/**
 * Atomically write `content` to `targetPath` via a sibling `.tmp` file.
 *
 * Guarantees:
 * - Reader of `targetPath` sees either the old content or the new content,
 *   never a partial write.
 * - The path must resolve under `.qult/` (enforced by {@link assertConfinedToQult}).
 *
 * Side effects: creates parent directories as needed.
 */
export function atomicWrite(targetPath: string, content: string): void {
	assertConfinedToQult(targetPath);
	ensureDir(dirname(targetPath));
	const tmp = `${targetPath}.tmp`;
	writeFileSync(tmp, content, { encoding: "utf8", mode: 0o644 });
	renameSync(tmp, targetPath);
}

/**
 * Read a UTF-8 file and reject anything > {@link MAX_READ_BYTES}.
 * Returns `null` if the file does not exist (ENOENT).
 */
export function readTextIfExists(absPath: string): string | null {
	assertConfinedToQult(absPath);
	try {
		const buf = readFileSync(absPath);
		if (buf.byteLength > MAX_READ_BYTES) {
			throw new Error(
				`file too large: ${absPath} (${buf.byteLength} bytes > ${MAX_READ_BYTES})`,
			);
		}
		return buf.toString("utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

/** Read a UTF-8 file. Throws if missing. */
export function readText(absPath: string): string {
	const txt = readTextIfExists(absPath);
	if (txt === null) throw new Error(`file not found: ${absPath}`);
	return txt;
}

/**
 * Read a JSON file shaped as `{ schema_version: number, ...rest }`.
 *
 * - Returns `null` if the file does not exist.
 * - Throws if JSON is malformed or `schema_version` mismatches.
 *
 * The caller specifies `expectedVersion`. We do not auto-migrate; callers
 * decide how to handle a version mismatch (typically: log + reset).
 */
export function readJson<T extends { schema_version: number }>(
	absPath: string,
	expectedVersion: number,
): T | null {
	const txt = readTextIfExists(absPath);
	if (txt === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(txt);
	} catch (err) {
		throw new Error(`malformed JSON in ${absPath}: ${(err as Error).message}`);
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		typeof (parsed as { schema_version?: unknown }).schema_version !== "number"
	) {
		throw new Error(`missing or invalid schema_version in ${absPath}`);
	}
	const version = (parsed as { schema_version: number }).schema_version;
	if (version !== expectedVersion) {
		throw new Error(
			`schema_version mismatch in ${absPath}: expected ${expectedVersion}, got ${version}`,
		);
	}
	return parsed as T;
}

/** Atomically write a JSON object (pretty-printed with 2-space indent). */
export function writeJson(absPath: string, value: object): void {
	atomicWrite(absPath, `${JSON.stringify(value, null, 2)}\n`);
}
