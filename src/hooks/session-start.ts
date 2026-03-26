import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { clearHandoff, readHandoff } from "../state/handoff.ts";
import type { HookEvent } from "../types.ts";
import { respond } from "./respond.ts";

/** SessionStart: ensure .alfred/ exists, inject handoff context */
export default async function sessionStart(_ev: HookEvent): Promise<void> {
	const stateDir = join(process.cwd(), ".alfred", ".state");
	if (!existsSync(stateDir)) {
		mkdirSync(stateDir, { recursive: true });
	}

	const handoff = readHandoff();
	if (handoff) {
		const lines = [
			`Previous session state (saved ${handoff.saved_at}):`,
			`Summary: ${handoff.summary}`,
		];
		if (handoff.changed_files.length > 0) {
			lines.push(`Changed files: ${handoff.changed_files.join(", ")}`);
		}
		if (handoff.pending_fixes) {
			lines.push("WARNING: There are pending lint/type fixes from the previous session.");
		}
		lines.push(`Next steps: ${handoff.next_steps}`);

		respond(lines.join("\n"));
		clearHandoff();
	}
}
