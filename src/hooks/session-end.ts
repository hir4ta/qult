import { writeHandoff } from "../state/handoff.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import type { HookEvent } from "../types.ts";

/** SessionEnd: save state on any exit (complement to PreCompact for non-normal exits) */
export default async function sessionEnd(_ev: HookEvent): Promise<void> {
	try {
		const fixes = readPendingFixes();
		const changedFiles = getChangedFiles();

		writeHandoff({
			summary: "Session ended",
			changed_files: changedFiles,
			pending_fixes: fixes.length > 0,
			next_steps:
				fixes.length > 0
					? `Fix pending errors: ${fixes.map((f) => f.file).join(", ")}`
					: "Continue from where you left off",
			saved_at: new Date().toISOString(),
		});
	} catch {
		// fail-open: session is ending, don't crash
	}
}

function getChangedFiles(): string[] {
	try {
		const result = Bun.spawnSync(["git", "diff", "--name-only", "HEAD"], {
			cwd: process.cwd(),
			timeout: 3000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.exitCode !== 0) return [];
		return result.stdout
			.toString()
			.split("\n")
			.filter((line) => line.trim().length > 0);
	} catch {
		return [];
	}
}
