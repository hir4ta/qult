import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SCOPED_FILE_RE = /^(session-state|pending-fixes)-.+\.json$/;

/** Remove session-scoped state files older than 24h. */
export function cleanupStaleScopedFiles(stateDir: string): void {
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
