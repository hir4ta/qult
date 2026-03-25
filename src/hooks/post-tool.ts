import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";

/**
 * PostToolUse handler (v2): detection + DIRECTIVE injection.
 * Cannot block — uses DIRECTIVE to prompt Claude to fix issues.
 *
 * Triggers:
 * - Edit/Write: run on_write gates → pending-fixes → DIRECTIVE
 * - Bash (test): parse results → error_resolution search → inject
 * - Bash (git commit): run on_commit gates → DIRECTIVE
 * - Bash (error): error_resolution search → inject
 */
export async function postToolUse(ev: HookEvent, signal: AbortSignal): Promise<void> {
	if (!ev.cwd || !ev.tool_name) return;

	// Read/Grep/Glob: no post-processing needed.
	if (ev.tool_name === "Read" || ev.tool_name === "Grep" || ev.tool_name === "Glob") {
		return;
	}

	const items: DirectiveItem[] = [];

	// TODO (Phase 2): Implement v2 PostToolUse logic
	// - Edit/Write → run on_write gates, update pending-fixes.json, DIRECTIVE on fail
	// - Bash success + test command → parse results, search error_resolution
	// - Bash success + git commit → run on_commit gates
	// - Bash error → search error_resolution via Voyage vector search
	// - Task completion → Self-reflection DIRECTIVE

	emitDirectives("PostToolUse", items);
}

/**
 * Detect git commit from Bash stdout.
 * Kept from v1 — still needed for commit gate detection.
 */
export function isGitCommit(stdout: string): boolean {
	if (!stdout) return false;
	return (
		/\[[\w./-]+ [0-9a-f]+\]/.test(stdout) ||
		(stdout.includes("files changed") &&
			(stdout.includes("insertion") || stdout.includes("deletion"))) ||
		/Merge made by the/.test(stdout) ||
		/Fast-forward/.test(stdout) ||
		/Successfully rebased/.test(stdout) ||
		/cherry-picked/i.test(stdout)
	);
}
