import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HookEvent, PendingFix } from "../types.ts";

/**
 * PostCompact: re-inject qult state summary into Claude's context after compaction.
 * Outputs to stdout (PostCompact stdout goes to Claude's context).
 * This is the primary instruction drift defense after context compression.
 */
export default async function postCompact(_ev: HookEvent): Promise<void> {
	try {
		const stateDir = join(process.cwd(), ".qult", ".state");
		if (!existsSync(stateDir)) return;

		const parts: string[] = [];

		// Pending fixes
		const fixesPath = findLatestFile(stateDir, "pending-fixes");
		if (fixesPath) {
			const fixes = safeReadJson<PendingFix[]>(fixesPath, []);
			if (fixes.length > 0) {
				parts.push(`[qult] ${fixes.length} pending fix(es):`);
				for (const fix of fixes) {
					parts.push(`  [${fix.gate}] ${fix.file}`);
				}
			}
		}

		// Session state summary
		const statePath = findLatestFile(stateDir, "session-state");
		if (statePath) {
			const state = safeReadJson<Record<string, unknown>>(statePath, {});
			if (Object.keys(state).length > 0) {
				const summary: string[] = [];
				// Only show NOT PASSED / NOT DONE when gates exist (avoid misleading for doc-only projects)
				const gatesPath = join(process.cwd(), ".qult", "gates.json");
				const hasGates = existsSync(gatesPath);
				if (state.test_passed_at) summary.push(`test_passed_at: ${state.test_passed_at}`);
				else if (hasGates) summary.push("tests: NOT PASSED");
				if (state.review_completed_at)
					summary.push(`review_completed_at: ${state.review_completed_at}`);
				else if (hasGates) summary.push("review: NOT DONE");
				const files = state.changed_file_paths;
				if (Array.isArray(files) && files.length > 0)
					summary.push(`${files.length} file(s) changed`);
				// Disabled gates
				const disabled = state.disabled_gates;
				if (Array.isArray(disabled) && disabled.length > 0)
					summary.push(`disabled gates: ${disabled.join(", ")}`);
				// Review iteration
				const reviewIter = state.review_iteration;
				if (typeof reviewIter === "number" && reviewIter > 0)
					summary.push(`review iteration: ${reviewIter}`);
				if (summary.length > 0) {
					parts.push(`[qult] Session: ${summary.join(", ")}`);
				}
			}
		}

		// Plan task status
		try {
			const planDir = join(process.cwd(), ".claude", "plans");
			if (existsSync(planDir)) {
				const planFiles = readdirSync(planDir)
					.filter((f) => f.endsWith(".md"))
					.map((f) => ({ name: f, mtime: statSync(join(planDir, f)).mtimeMs }))
					.sort((a, b) => b.mtime - a.mtime);
				if (planFiles.length > 0) {
					const content = readFileSync(join(planDir, planFiles[0]!.name), "utf-8");
					const taskCount = (content.match(/^###\s+Task\s+\d+/gim) ?? []).length;
					const doneCount = (content.match(/^###\s+Task\s+\d+.*\[done\]/gim) ?? []).length;
					if (taskCount > 0) {
						parts.push(`[qult] Plan: ${doneCount}/${taskCount} tasks done`);
					}
				}
			}
		} catch {
			/* fail-open */
		}

		if (parts.length > 0) {
			process.stdout.write(parts.join("\n"));
		}
	} catch {
		/* fail-open */
	}
}

/** Find the latest file matching prefix in state dir (by mtime). */
function findLatestFile(stateDir: string, prefix: string): string | null {
	try {
		const files = readdirSync(stateDir)
			.filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
			.map((f) => ({
				path: join(stateDir, f),
				mtime: statSync(join(stateDir, f)).mtimeMs,
			}))
			.sort((a, b) => b.mtime - a.mtime);
		return files.length > 0 ? files[0]!.path : null;
	} catch {
		return null;
	}
}

function safeReadJson<T>(path: string, fallback: T): T {
	try {
		if (!existsSync(path)) return fallback;
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return fallback;
	}
}
