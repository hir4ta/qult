import { readPendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent } from "../types.ts";

/** PostCompact: remind about pending fixes after context compaction */
export default async function postCompact(_ev: HookEvent): Promise<void> {
	const fixes = readPendingFixes();
	if (fixes.length > 0) {
		process.stderr.write(
			`[alfred] WARNING: ${fixes.length} pending lint/type fix(es). Fix them before continuing.\n`,
		);
	}
}
