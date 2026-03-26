import { isPaceRed, readPace } from "../state/pace.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent, HookResponse } from "../types.ts";

/** PreToolUse: DENY if pending-fixes exist on other files, pace check */
export default async function preTool(ev: HookEvent): Promise<void> {
	const tool = ev.tool_name;
	if (tool !== "Edit" && tool !== "Write") return;

	const targetFile = ev.tool_input?.file_path as string | undefined;
	if (!targetFile) return;

	// Check pending fixes
	const fixes = readPendingFixes();
	if (fixes.length > 0) {
		const isFixingPendingFile = fixes.some(
			(f) => targetFile.endsWith(f.file) || f.file.endsWith(targetFile),
		);

		if (!isFixingPendingFile) {
			const fileList = fixes
				.map((f) => `  ${f.file}: ${f.errors[0]?.slice(0, 100) ?? "error"}`)
				.join("\n");
			deny(`Fix existing errors before editing other files:\n${fileList}`);
			return;
		}
	}

	// Check pace
	const pace = readPace();
	if (isPaceRed(pace)) {
		deny("35+ minutes without commit on 5+ files. Commit your current changes before continuing.");
		return;
	}
}

function deny(reason: string): void {
	const response: HookResponse = {
		hookSpecificOutput: {
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	};
	process.stdout.write(JSON.stringify(response));
	process.exit(2);
}
