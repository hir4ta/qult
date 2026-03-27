import { readPendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent } from "../types.ts";

/** PreCompact: remind about pending fixes before context compaction */
export default async function preCompact(_ev: HookEvent): Promise<void> {
	const fixes = readPendingFixes();
	if (fixes.length > 0) {
		process.stderr.write(
			`[alfred] ${fixes.length} pending fix(es) — fix before continuing: ${fixes.map((f) => f.file).join(", ")}\n`,
		);
	}
}
