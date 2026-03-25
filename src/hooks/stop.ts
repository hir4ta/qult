import type { HookEvent } from "./dispatcher.js";
import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";

/**
 * Stop handler (v2): soft reminders (no hard blocking).
 *
 * Flow:
 * 1. Check for untested changed files → CONTEXT
 * 2. Check pending-fixes → WARNING
 * 3. Save final quality summary
 */
export async function stop(ev: HookEvent): Promise<void> {
	if (!ev.cwd) return;

	const items: DirectiveItem[] = [];

	// TODO (Phase 4): Implement v2 Stop logic
	// 1. git diff --name-only → check for changed files without test updates → CONTEXT
	// 2. pending-fixes.json → WARNING if unresolved
	// 3. quality summary final save

	emitDirectives("Stop", items);
}
