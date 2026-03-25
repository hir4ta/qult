import type { HookEvent } from "./dispatcher.js";
import { emitAdditionalContext } from "./dispatcher.js";

/**
 * SessionStart handler (v2): initial context injection.
 *
 * Flow:
 * 1. Project profiling (first run: auto-detect language, test fw, linter)
 * 2. Previous session quality summary injection
 * 3. Conventions injection (top 5)
 * 4. Knowledge sync (.alfred/knowledge/ → DB)
 */
export async function sessionStart(ev: HookEvent, signal: AbortSignal): Promise<void> {
	if (!ev.cwd) return;

	// TODO (Phase 2): Implement v2 SessionStart logic
	// 1. Check/create project-profile.json
	// 2. Read session-summary.json → inject CONTEXT
	// 3. Read conventions.json → inject CONTEXT (max 5)
	// 4. Sync .alfred/knowledge/ → DB
}
