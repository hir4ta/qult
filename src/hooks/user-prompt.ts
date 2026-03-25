import type { HookEvent } from "./dispatcher.js";
import { emitAdditionalContext } from "./dispatcher.js";

/**
 * UserPromptSubmit handler (v2): Plan mode power-up + knowledge injection.
 *
 * Flow:
 * 1. Detect plan/implementation prompt → DIRECTIVE (test-first, acceptance criteria)
 * 2. Vector search error_resolution + exemplar → CONTEXT injection
 * 3. Convention contradiction check → WARNING
 */
export async function userPromptSubmit(ev: HookEvent, signal: AbortSignal): Promise<void> {
	if (!ev.cwd) return;

	// TODO (Phase 2): Implement v2 UserPromptSubmit logic
	// 1. Plan mode detection → DIRECTIVE (test-first enforcement)
	// 2. Voyage vector search (error_resolution + exemplar) → CONTEXT
	// 3. Convention contradiction check → WARNING
}
