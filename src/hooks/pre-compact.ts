import { execFileSync } from "node:child_process";
import type { Store } from "../store/index.js";
import { openDefaultCached } from "../store/index.js";
import { resolveOrRegisterProject } from "../store/project.js";
import { calculateQualityScore, getSessionSummary } from "../store/quality-events.js";
import type { HookEvent } from "./dispatcher.js";
import { hasPendingFixes } from "./pending-fixes.js";
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
 * PreCompact handler: session learning extraction + quality summary + chapter memory.
 */
export async function preCompact(ev: HookEvent, signal: AbortSignal): Promise<void> {
	if (!ev.cwd) return;

	// 1. Quality summary → .alfred/.state/session-summary.json
	saveQualitySummary(ev.cwd);

	// 2. Chapter memory → .alfred/.state/chapter.json
	saveChapterMemory(ev.cwd);

	// TODO (Phase 4+): Agent hook for error_resolution extraction from transcript
}

function saveQualitySummary(cwd: string): void {
	try {
		const store = openDefaultCached();
		const project = resolveOrRegisterProject(store, cwd);
		const sessionId = findLatestSessionId(store);
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

/**
 * Save chapter memory — work state for session continuity after compaction.
 * Captures: what was being worked on, changed files, unresolved issues.
 */
function saveChapterMemory(cwd: string): void {
	try {
		const changedFiles = getChangedFiles(cwd);
		const hasFixes = hasPendingFixes(cwd);

		writeStateJSON(cwd, "chapter.json", {
			changed_files: changedFiles,
			has_pending_fixes: hasFixes,
			saved_at: new Date().toISOString(),
		});
	} catch {
		/* fail-open */
	}
}

function getChangedFiles(cwd: string): string[] {
	try {
		const output = execFileSync("git", ["diff", "--name-only"], {
			cwd,
			timeout: 2000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim().split("\n").filter(Boolean).slice(0, 20);
	} catch {
		return [];
	}
}
