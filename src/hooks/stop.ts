import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";
import { hasPendingFixes, readPendingFixes, formatPendingFixes } from "./pending-fixes.js";

/**
 * Stop handler: soft reminders (no hard blocking).
 *
 * Phase 2: pending-fixes warning.
 * Phase 4: untested file check, final quality summary save.
 */
export async function stop(ev: HookEvent): Promise<void> {
	if (!ev.cwd) return;

	const items: DirectiveItem[] = [];

	// 1. Check pending-fixes → WARNING if unresolved
	if (hasPendingFixes(ev.cwd)) {
		const fixes = readPendingFixes(ev.cwd);
		const formatted = formatPendingFixes(fixes);
		items.push({
			level: "WARNING",
			message: `Unresolved lint/type errors remain:\n${formatted}`,
		});
	}

	// TODO (Phase 4):
	// 2. git diff --name-only → changed files without test updates → CONTEXT
	// 3. quality summary final save

	emitDirectives("Stop", items);
}
