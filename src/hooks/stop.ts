import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Store } from "../store/index.js";
import { openDefaultCached } from "../store/index.js";
import { resolveOrRegisterProject } from "../store/project.js";
import { calculateQualityScore, getSessionSummary } from "../store/quality-events.js";
import { guessTestFile, isSourceFile } from "./detect.js";
import type { HookEvent } from "./dispatcher.js";
import { formatPendingFixes, hasPendingFixes, readPendingFixes } from "./pending-fixes.js";
import { writeStateJSON } from "./state.js";

function findLatestSessionId(store: Store): string | null {
	try {
		const row = store.db
			.prepare("SELECT DISTINCT session_id FROM quality_events ORDER BY created_at DESC LIMIT 1")
			.get() as { session_id: string } | undefined;
		return row?.session_id ?? null;
	} catch {
		return null;
	}
}

/**
 * Stop handler: soft reminders + final quality summary save.
 */
export async function stop(ev: HookEvent): Promise<void> {
	if (!ev.cwd) return;

	const items: Array<{ level: string; message: string }> = [];

	// 1. Check pending-fixes → WARNING
	if (hasPendingFixes(ev.cwd)) {
		const fixes = readPendingFixes(ev.cwd);
		const formatted = formatPendingFixes(fixes);
		items.push({
			level: "WARNING",
			message: `Unresolved lint/type errors remain:\n${formatted}`,
		});
	}

	// 2. Untested changes check
	const untested = findUntestedChanges(ev.cwd);
	if (untested.length > 0) {
		items.push({
			level: "CONTEXT",
			message: `Changed files without test updates: ${untested.join(", ")}`,
		});
	}

	// 3. Save final quality summary
	saveFinalQualitySummary(ev.cwd, ev.session_id);

	// Stop hook does not support hookSpecificOutput in the official schema.
	// Output warnings to stderr instead.
	if (items.length > 0) {
		for (const item of items) {
			process.stderr.write(`[alfred] [${item.level}] ${item.message}\n`);
		}
	}
}

function findUntestedChanges(cwd: string): string[] {
	try {
		const output = execFileSync("git", ["diff", "--name-only"], {
			cwd,
			timeout: 2000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const changedFiles = output.trim().split("\n").filter(Boolean);

		const changedSet = new Set(changedFiles);
		const untested: string[] = [];

		for (const file of changedFiles) {
			if (!isSourceFile(file)) continue;
			const testFile = guessTestFile(file);
			if (testFile && !changedSet.has(testFile) && existsSync(`${cwd}/${testFile}`)) {
				// Test file exists but wasn't modified → might need updates
				untested.push(file);
			}
		}

		return untested.slice(0, 5);
	} catch {
		return [];
	}
}

function saveFinalQualitySummary(cwd: string, evSessionId?: string): void {
	try {
		const store = openDefaultCached();
		resolveOrRegisterProject(store, cwd);
		const sessionId = evSessionId ?? findLatestSessionId(store);
		if (!sessionId) return;

		const summary = getSessionSummary(store, sessionId);
		const score = calculateQualityScore(store, sessionId);

		writeStateJSON(cwd, "session-summary.json", {
			...summary,
			score: score.sessionScore,
			saved_at: new Date().toISOString(),
		});
	} catch {
		/* fail-open */
	}
}
