import { existsSync } from "node:fs";
import { guessTestFile, isSourceFile } from "./detect.js";
import type { DirectiveItem } from "./directives.js";
import { emitDirectives } from "./directives.js";
import type { HookEvent } from "./dispatcher.js";
import { formatPendingFixes, hasPendingFixes, readPendingFixes } from "./pending-fixes.js";
import { checkPaceRedThreshold } from "./pace.js";
import { readStateJSON } from "./state.js";

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

	// 0. Pace red threshold → DENY if session too long without commits
	//    Don't block if pending-fixes exist (let fixes complete first).
	if (!hasPendingFixes(ev.cwd) && checkPaceRedThreshold(ev.cwd)) {
		process.stderr.write(
			"Session pace limit exceeded (35+ min, many files). Commit your current progress before making more changes.\n",
		);
		process.exit(2);
	}

	// 1. Check pending-fixes → DENY if unresolved errors exist
	//    Allow edits to files that already have pending fixes (so they can be fixed).
	if (hasPendingFixes(ev.cwd)) {
		const fixes = readPendingFixes(ev.cwd);
		const pendingFiles = Object.keys(fixes.files);
		const isFixingPendingFile = filePath && pendingFiles.includes(filePath);

		if (!isFixingPendingFile) {
			const formatted = formatPendingFixes(fixes);
			// Exit code 2 = DENY
			process.stderr.write(`Fix lint/type errors before editing more files:\n${formatted}\n`);
			process.exit(2);
		}
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

		// Proactive context: risk warnings + co-change hints
		injectProactiveContext(ev.cwd, filePath, items);
	}

	if (items.length > 0) {
		emitDirectives("PreToolUse", items, ev.cwd);
	}
}

function injectProactiveContext(cwd: string, filePath: string, items: DirectiveItem[]): void {
	try {
		const { getRiskWarning, getCoChangeHints } =
			require("./proactive.js") as typeof import("./proactive.js");

		const risks = readStateJSON<Array<{ file: string; score: number; reasons: string[] }>>(cwd, "risk-scores.json", []);
		const coChanges = readStateJSON<Array<{ file: string; partner: string; count: number }>>(cwd, "co-change-graph.json", []);

		const warning = getRiskWarning(filePath, risks);
		if (warning) {
			items.push({ level: "WARNING", message: warning });
		}

		const hints = getCoChangeHints(filePath, coChanges);
		if (hints.length > 0) {
			items.push({ level: "CONTEXT", message: `Often changed together with: ${hints.join(", ")}` });
		}
	} catch {
		/* fail-open */
	}
}
