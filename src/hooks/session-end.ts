import { readPendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent } from "../types.ts";

/** SessionEnd: log pending state on exit */
export default async function sessionEnd(_ev: HookEvent): Promise<void> {
	try {
		const fixes = readPendingFixes();
		if (fixes.length > 0) {
			process.stderr.write(
				`[alfred] Session ended with ${fixes.length} pending fix(es): ${fixes.map((f) => f.file).join(", ")}\n`,
			);
		}
	} catch {
		// fail-open: session is ending, don't crash
	}
}
