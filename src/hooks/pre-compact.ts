import { execSync } from "node:child_process";
import { writeHandoff } from "../state/handoff.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent } from "../types.ts";

/** PreCompact: save structured handoff state before context compaction */
export default async function preCompact(_ev: HookEvent): Promise<void> {
	const fixes = readPendingFixes();
	const changedFiles = getChangedFiles();

	const summary =
		fixes.length > 0
			? `Session interrupted with ${fixes.length} pending fix(es) in: ${fixes.map((f) => f.file).join(", ")}`
			: changedFiles.length > 0
				? `Modified ${changedFiles.length} file(s): ${changedFiles.slice(0, 5).join(", ")}${changedFiles.length > 5 ? ` (+${changedFiles.length - 5} more)` : ""}`
				: "Session started, no changes yet";

	writeHandoff({
		summary,
		changed_files: changedFiles,
		pending_fixes: fixes.length > 0,
		next_steps:
			fixes.length > 0
				? `Fix pending lint/type errors: ${fixes.map((f) => f.file).join(", ")}`
				: "Continue implementation",
		saved_at: new Date().toISOString(),
	});
}

/** Get list of changed files from git */
function getChangedFiles(): string[] {
	try {
		const output = execSync("git diff --name-only HEAD", {
			cwd: process.cwd(),
			timeout: 3000,
			encoding: "utf-8",
		});
		return output.split("\n").filter((line) => line.trim().length > 0);
	} catch {
		return [];
	}
}
