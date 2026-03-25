import type { HookEvent } from "./dispatcher.js";
import { emitAdditionalContext } from "./dispatcher.js";

const BLOCKABLE_TOOLS = new Set(["Edit", "Write"]);

/**
 * PreToolUse handler (v2): quality gate.
 * Can DENY Edit/Write if pending-fixes exist.
 *
 * Flow:
 * 1. Check pending-fixes.json → DENY if unresolved errors
 * 2. Convention check → CONTEXT injection
 * 3. Test adjacency check → WARNING if no test file
 */
export async function preToolUse(ev: HookEvent): Promise<void> {
	const toolName = ev.tool_name ?? "";

	// Only gate Edit/Write. Everything else passes through.
	if (!BLOCKABLE_TOOLS.has(toolName)) return;

	// TODO (Phase 2): Implement v2 PreToolUse logic
	// 1. Read .alfred/.state/pending-fixes.json
	//    → If unresolved lint/type errors: exit 2 + stderr (DENY)
	// 2. Convention check for target file's directory
	//    → Inject convention as CONTEXT
	// 3. Test adjacency check
	//    → WARNING if no corresponding test file

	// For now: allow all Edit/Write (no v1 gates)
}
