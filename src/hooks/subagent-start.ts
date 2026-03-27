import { readPendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent } from "../types.ts";
import { respond } from "./respond.ts";

/**
 * SubagentStart: inject pending-fixes state into subagent context.
 *
 * Subagents don't read .alfred/.state/ — they need explicit notification
 * about pending fixes to avoid editing blocked files.
 *
 * Quality rules injection was removed: Opus 4.6 subagents inherit project
 * rules from CLAUDE.md and ~/.claude/rules/ automatically.
 *
 * Source: Anthropic "Harness Design" (2026-03-24)
 *   "every component encodes an assumption about what the model can't do
 *    on its own, and those assumptions are worth stress testing"
 */
export default async function subagentStart(_ev: HookEvent): Promise<void> {
	const fixes = readPendingFixes();
	if (fixes.length === 0) return;

	const fileList = fixes.map((f) => f.file).join(", ");
	respond(
		`WARNING: There are pending lint/type fixes: ${fileList}. Do not edit other files until these are resolved.`,
	);
}
