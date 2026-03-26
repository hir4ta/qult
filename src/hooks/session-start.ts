import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectGates } from "../gates/detect.ts";
import { getTopErrors } from "../state/gate-history.ts";
import { clearHandoff, readHandoff } from "../state/handoff.ts";
import type { HookEvent } from "../types.ts";
import { respond } from "./respond.ts";

/** SessionStart: ensure .alfred/ exists, auto-detect gates, inject handoff context */
export default async function sessionStart(_ev: HookEvent): Promise<void> {
	const alfredDir = join(process.cwd(), ".alfred");
	const stateDir = join(alfredDir, ".state");
	if (!existsSync(stateDir)) {
		mkdirSync(stateDir, { recursive: true });
	}

	// Auto-detect gates if missing (zero-config)
	const gatesPath = join(alfredDir, "gates.json");
	if (!existsSync(gatesPath)) {
		try {
			const gates = detectGates(process.cwd());
			writeFileSync(gatesPath, JSON.stringify(gates, null, 2));
		} catch {
			// fail-open
		}
	}

	// Collect all context into a single message (respond() must be called at most once)
	const contextParts: string[] = [];

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
		contextParts.push(lines.join("\n"));
		clearHandoff();
	}

	// Frequent error trends
	const topErrors = getTopErrors(3);
	if (topErrors.length > 0) {
		const errorLines = topErrors.map((e) => `- ${e.gate}: "${e.error}" (${e.count}x)`);
		contextParts.push(
			`Frequent errors in this project:\n${errorLines.join("\n")}\nAvoid these patterns.`,
		);
	}

	if (contextParts.length > 0) {
		respond(contextParts.join("\n\n"));
	}
}
