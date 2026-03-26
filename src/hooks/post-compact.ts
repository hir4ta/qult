import { readHandoff } from "../state/handoff.ts";
import type { HookEvent } from "../types.ts";

/** PostCompact: restore handoff context after context compaction */
export default async function postCompact(_ev: HookEvent): Promise<void> {
	const handoff = readHandoff();
	if (!handoff) return;

	const lines = [
		`[Handoff restored — saved at ${handoff.saved_at}]`,
		`Summary: ${handoff.summary}`,
	];

	if (handoff.changed_files.length > 0) {
		lines.push(`Changed files: ${handoff.changed_files.join(", ")}`);
	}

	if (handoff.pending_fixes) {
		lines.push("WARNING: There are pending lint/type fixes. Fix them before continuing.");
	}

	lines.push(`Next steps: ${handoff.next_steps}`);

	// PostCompact does not support hookSpecificOutput.additionalContext
	process.stderr.write(`[alfred] ${lines.join("\n")}\n`);
}
