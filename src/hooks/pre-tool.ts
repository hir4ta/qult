import { resolve } from "node:path";
import { isPaceRed, readPace } from "../state/pace.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent } from "../types.ts";
import { deny } from "./respond.ts";

/** PreToolUse: DENY if pending-fixes exist on other files, pace check */
export default async function preTool(ev: HookEvent): Promise<void> {
	const tool = ev.tool_name;
	if (tool !== "Edit" && tool !== "Write") return;

	const targetFile = typeof ev.tool_input?.file_path === "string" ? ev.tool_input.file_path : null;
	if (!targetFile) return;

	const fixes = readPendingFixes();
	if (fixes.length > 0) {
		const resolvedTarget = resolve(targetFile);
		const isFixingPendingFile = fixes.some((f) => resolve(f.file) === resolvedTarget);

		if (!isFixingPendingFile) {
			const fileList = fixes
				.map((f) => `  ${f.file}: ${f.errors[0]?.slice(0, 100) ?? "error"}`)
				.join("\n");
			deny(`Fix existing errors before editing other files:\n${fileList}`);
		}
	}

	const pace = readPace();
	if (isPaceRed(pace)) {
		deny("35+ minutes without commit on 5+ files. Commit your current changes before continuing.");
	}
}
