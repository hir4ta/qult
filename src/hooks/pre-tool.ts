import { existsSync } from "node:fs";
import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";
import {
	formatPendingFixes,
	hasPendingFixes,
	readPendingFixes,
} from "./pending-fixes.js";
import { isSourceFile, guessTestFile } from "./detect.js";

const BLOCKABLE_TOOLS = new Set(["Edit", "Write"]);

/**
 * PreToolUse handler: quality gate.
 * Can DENY Edit/Write if pending-fixes exist.
 *
 * Flow:
 * 1. Check pending-fixes.json → DENY if unresolved errors
 * 2. Test adjacency check → WARNING if no test file
 */
export async function preToolUse(ev: HookEvent): Promise<void> {
	const toolName = ev.tool_name ?? "";

	// Only gate Edit/Write. Everything else passes through.
	if (!BLOCKABLE_TOOLS.has(toolName)) return;
	if (!ev.cwd) return;

	const toolInput = (ev.tool_input ?? {}) as Record<string, unknown>;
	const filePath = (toolInput.file_path as string) ?? "";

	// 1. Check pending-fixes → DENY if unresolved errors exist
	if (hasPendingFixes(ev.cwd)) {
		const fixes = readPendingFixes(ev.cwd);
		const formatted = formatPendingFixes(fixes);

		// Exit code 2 = DENY
		process.stderr.write(
			`Fix lint/type errors before editing more files:\n${formatted}\n`,
		);
		process.exit(2);
	}

	// 2. Context injection (non-blocking)
	const items: DirectiveItem[] = [];

	// Test adjacency check for source files
	if (filePath && isSourceFile(filePath)) {
		const testFile = guessTestFile(filePath);
		if (testFile && !existsSync(testFile)) {
			items.push({
				level: "WARNING",
				message: `No test file found for ${filePath}. Consider creating ${testFile}.`,
			});
		}
	}

	if (items.length > 0) {
		emitDirectives("PreToolUse", items);
	}
}
