import { flushAll } from "../state/flush.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import { readSessionState } from "../state/session-state.ts";
import { sanitizeForStderr } from "./sanitize.ts";

/** Generate a compact one-line state summary for instruction drift defense.
 *  Appended to every deny/block message so Claude always sees the full picture. */
export function compactStateSummary(): string {
	try {
		const state = readSessionState();
		const fixes = readPendingFixes();
		const parts: string[] = [];
		if (fixes.length > 0) parts.push(`${fixes.length} pending fix(es)`);
		parts.push(state.test_passed_at ? "tests: PASS" : "tests: NOT PASSED");
		parts.push(state.review_completed_at ? "review: DONE" : "review: NOT DONE");
		const changed = state.changed_file_paths?.length ?? 0;
		if (changed > 0) parts.push(`${changed} file(s) changed`);
		const disabled = state.disabled_gates ?? [];
		if (disabled.length > 0)
			parts.push(`disabled: ${disabled.map((g) => sanitizeForStderr(g)).join(",")}`);
		return `\n[qult state] ${parts.join(" | ")}`;
	} catch {
		return ""; // fail-open
	}
}

/** DENY: block the action (exit 2).
 * stderr-only, no stdout — bypasses plugin hook output bug (#16538).
 * Only valid for: PreToolUse */
export function deny(reason: string): never {
	try {
		flushAll();
	} catch {
		/* fail-open */
	}
	process.stderr.write(reason + compactStateSummary());
	process.exit(2);
}

/** Block Claude from stopping (exit 2).
 * stderr-only, no stdout — bypasses plugin hook output bug (#16538).
 * Valid for: Stop, SubagentStop */
export function block(reason: string): never {
	try {
		flushAll();
	} catch {
		/* fail-open */
	}
	process.stderr.write(reason + compactStateSummary());
	process.exit(2);
}
