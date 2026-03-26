import { resolve } from "node:path";
import { loadGates } from "../gates/load.ts";
import { readLastTestPass } from "../state/last-test-pass.ts";
import { isPaceRed, readPace } from "../state/pace.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent } from "../types.ts";
import { deny } from "./respond.ts";

const GIT_COMMIT_RE = /\bgit\s+commit\b/;

/** PreToolUse: DENY pending-fixes edits, pace red, and commit without tests */
export default async function preTool(ev: HookEvent): Promise<void> {
	const tool = ev.tool_name;

	if (tool === "Edit" || tool === "Write") {
		checkEditWrite(ev);
	} else if (tool === "Bash") {
		checkBash(ev);
	}
}

function checkEditWrite(ev: HookEvent): void {
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

function checkBash(ev: HookEvent): void {
	const command = typeof ev.tool_input?.command === "string" ? ev.tool_input.command : null;
	if (!command) return;
	if (!GIT_COMMIT_RE.test(command)) return;

	// Only enforce test pass if project has test gates configured
	const gates = loadGates();
	if (!gates?.on_commit || Object.keys(gates.on_commit).length === 0) return;

	const lastPass = readLastTestPass();
	if (!lastPass) {
		deny("Run tests before committing. No test pass recorded since last commit.");
	}
}
