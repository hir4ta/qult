import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HookEvent, PendingFix } from "../types.ts";

/**
 * PostCompact: re-inject qult state summary into Claude's context after compaction.
 * Outputs to stdout (PostCompact stdout goes to Claude's context).
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
				if (state.test_passed_at) summary.push(`test_passed_at: ${state.test_passed_at}`);
				if (state.review_completed_at)
					summary.push(`review_completed_at: ${state.review_completed_at}`);
				const files = state.changed_file_paths;
				if (Array.isArray(files) && files.length > 0)
					summary.push(`${files.length} file(s) changed`);
				if (summary.length > 0) {
					parts.push(`[qult] Session: ${summary.join(", ")}`);
				}
			}
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
