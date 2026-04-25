/**
 * Atomic file write for paths outside `.qult/` (integration config files at
 * project root). Uses the same `<file>.tmp + rename` pattern as state/fs but
 * without the .qult/ confinement assertion — callers must guard via
 * `assertConfinedToProject` before calling.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function atomicWriteAt(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, content, { encoding: "utf8", mode: 0o644 });
	renameSync(tmp, path);
}
