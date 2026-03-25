import type { HookEvent } from "./dispatcher.js";
import { writeStateJSON } from "./state.js";
import { openDefaultCached } from "../store/index.js";
import { resolveOrRegisterProject } from "../store/project.js";
import { getSessionSummary, calculateQualityScore } from "../store/quality-events.js";

/**
 * PreCompact handler: session learning extraction + quality summary.
 *
 * Phase 2: Quality summary save.
 * Phase 4: chapter memory, error_resolution extraction, agent hook.
 */
export async function preCompact(ev: HookEvent, signal: AbortSignal): Promise<void> {
	if (!ev.cwd) return;

	// 1. Quality summary → .alfred/.state/session-summary.json
	saveQualitySummary(ev.cwd);

	// TODO (Phase 4):
	// 2. error_resolution extraction from session
	// 3. Chapter memory → .alfred/.state/chapter.json
}

function saveQualitySummary(cwd: string): void {
	try {
		const store = openDefaultCached();
		const project = resolveOrRegisterProject(store, cwd);
		const sessionId = `session-${Date.now()}`; // Approximate — ideally from hook input

		const summary = getSessionSummary(store, sessionId);
		const score = calculateQualityScore(store, sessionId);

		writeStateJSON(cwd, "session-summary.json", {
			...summary,
			score: score.sessionScore,
			saved_at: new Date().toISOString(),
		});
	} catch {
		/* fail-open */
	}
}
