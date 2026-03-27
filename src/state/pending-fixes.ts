import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingFix } from "../types.ts";
import { atomicWriteJson } from "./atomic-write.ts";

const STATE_DIR = ".alfred/.state";
const FIXES_FILE = "pending-fixes.json";

function fixesPath(): string {
	return join(process.cwd(), STATE_DIR, FIXES_FILE);
}

/** Read current pending fixes. Returns empty array on any error (fail-open). */
export function readPendingFixes(): PendingFix[] {
	try {
		const path = fixesPath();
		if (!existsSync(path)) return [];
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

/** Write pending fixes to state file (atomic: write-to-temp + rename). */
export function writePendingFixes(fixes: PendingFix[]): void {
	try {
		atomicWriteJson(fixesPath(), fixes);
	} catch {
		// fail-open
	}
}

/** Remove all fixes for a specific file. */
export function clearFixesForFile(file: string): void {
	const fixes = readPendingFixes();
	const filtered = fixes.filter((f) => f.file !== file);
	writePendingFixes(filtered);
}
