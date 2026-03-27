import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectGates } from "../gates/detect.ts";
import { getTopErrors } from "../state/gate-history.ts";
import type { HookEvent } from "../types.ts";
import { respond } from "./respond.ts";

/** SessionStart: ensure .alfred/ exists, auto-detect gates, inject error trends */
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

	// Frequent error trends
	const topErrors = getTopErrors(3);
	if (topErrors.length > 0) {
		const errorLines = topErrors.map((e) => `- ${e.gate}: "${e.error}" (${e.count}x)`);
		respond(`Frequent errors in this project:\n${errorLines.join("\n")}\nAvoid these patterns.`);
	}
}
