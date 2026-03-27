import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadGates } from "../gates/load.ts";
import { getTopErrors } from "../state/gate-history.ts";
import { writePendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent } from "../types.ts";
import { respond } from "./respond.ts";

/** SessionStart: ensure .qult/ exists, prompt gate detection if empty, inject error trends */
export default async function sessionStart(_ev: HookEvent): Promise<void> {
	const qultDir = join(process.cwd(), ".qult");
	const stateDir = join(qultDir, ".state");
	if (!existsSync(stateDir)) {
		mkdirSync(stateDir, { recursive: true });
	}

	// Clear stale pending-fixes from previous session.
	// Gates will re-detect issues when files are edited in this session.
	writePendingFixes([]);

	// Prompt gate detection if gates are empty
	const gates = loadGates();
	const hasGates =
		gates &&
		(Object.keys(gates.on_write ?? {}).length > 0 ||
			Object.keys(gates.on_commit ?? {}).length > 0 ||
			Object.keys(gates.on_review ?? {}).length > 0);
	if (!hasGates) {
		respond(
			"Gates are not configured. Run /qult:detect-gates to auto-detect your project's lint, typecheck, and test tools.",
		);
		return;
	}

	// Frequent error trends
	const topErrors = getTopErrors(3);
	if (topErrors.length > 0) {
		const errorLines = topErrors.map((e) => `- ${e.gate}: "${e.error}" (${e.count}x)`);
		respond(`Frequent errors in this project:\n${errorLines.join("\n")}\nAvoid these patterns.`);
	}
}
