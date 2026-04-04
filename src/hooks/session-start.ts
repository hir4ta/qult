import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupStaleScopedFiles } from "../state/cleanup.ts";
import { flush as flushPendingFixes, writePendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent } from "../types.ts";
import { markSessionStartCompleted } from "./lazy-init.ts";

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
