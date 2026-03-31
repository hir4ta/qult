import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { flush as flushPendingFixes, writePendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent } from "../types.ts";
import { markSessionStartCompleted } from "./lazy-init.ts";

const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SCOPED_FILE_RE = /^(session-state|pending-fixes)-.+\.json$/;

/** SessionStart: initialize state directory, clean stale files, optionally clear pending-fixes. */
export default async function sessionStart(ev: HookEvent): Promise<void> {
	try {
		const stateDir = join(process.cwd(), ".qult", ".state");
		if (!existsSync(stateDir)) {
			mkdirSync(stateDir, { recursive: true });
		}

		cleanupStaleScopedFiles(stateDir);

		// Only clear pending-fixes on fresh session start (not compact/resume)
		if (ev.source === "startup" || ev.source === "clear") {
			writePendingFixes([]);
			try {
				flushPendingFixes();
			} catch {
				/* fail-open */
			}
		}

		markSessionStartCompleted();
	} catch {
		/* fail-open */
	}
}

function cleanupStaleScopedFiles(stateDir: string): void {
	try {
		const now = Date.now();
		for (const file of readdirSync(stateDir)) {
			if (!SCOPED_FILE_RE.test(file)) continue;
			const filePath = join(stateDir, file);
			const age = now - statSync(filePath).mtimeMs;
			if (age > STALE_MS) {
				unlinkSync(filePath);
			}
		}
	} catch {
		/* fail-open */
	}
}
