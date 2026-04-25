/**
 * Spec-related MCP tools (Wave 2 additions).
 *
 * - `get_active_spec`              — return the unique active spec or null
 * - `complete_wave`                — finalize a Wave (idempotent, range integrity)
 * - `update_task_status`           — flip a single task's status in tasks.md
 * - `archive_spec`                 — replaces archive_plan
 * - `record_spec_evaluator_score`  — record per-phase spec-evaluator scores
 *
 * All file I/O goes through the new state modules added in Wave 1.
 */

import { existsSync } from "node:fs";
import { atomicWrite, readText } from "../../state/fs.ts";
import {
	readStageScores,
	recordSpecEvalPhase,
	resetSpecEval,
	type SpecEvalPhase,
} from "../../state/json-state.ts";
import { getProjectRoot, tasksPath, wavePath } from "../../state/paths.ts";
import {
	archiveSpec as archiveSpecOnDisk,
	getActiveSpec as getActiveSpecOnDisk,
	gitHeadSha,
	isCommitReachable,
	listWaveNumbers,
	wavePathEnsured,
} from "../../state/spec.ts";
import {
	findNextIncompleteWave,
	parseTasksMd,
	setTaskStatus,
	summarizeTaskStatus,
	type TaskStatus,
} from "../../state/tasks-md.ts";
import { newWaveDoc, parseWaveMd, writeWaveMd } from "../../state/wave-md.ts";
import {
	errorResult,
	jsonResult,
	requireSpecName,
	requireWaveNum,
	type ToolResult,
} from "./shared.ts";

// =====================================================================
// get_active_spec
// =====================================================================

export function handleGetActiveSpec(): ToolResult {
	let info: ReturnType<typeof getActiveSpecOnDisk>;
	try {
		info = getActiveSpecOnDisk();
	} catch (err) {
		return errorResult((err as Error).message);
	}
	if (info === null) {
		return jsonResult(null);
	}
	const tasksFile = tasksPath(info.name);
	let tasksDoc: ReturnType<typeof parseTasksMd> | null = null;
	if (existsSync(tasksFile)) {
		try {
			tasksDoc = parseTasksMd(readText(tasksFile));
		} catch {
			tasksDoc = null;
		}
	}
	const totalWaves = tasksDoc?.waves.length ?? 0;
	const nextWave = tasksDoc ? findNextIncompleteWave(tasksDoc) : null;
	const summary = tasksDoc ? summarizeTaskStatus(tasksDoc) : null;
	return jsonResult({
		name: info.name,
		path: info.path,
		has_requirements: info.hasRequirements,
		has_design: info.hasDesign,
		has_tasks: info.hasTasks,
		total_waves: totalWaves,
		current_wave: nextWave?.num ?? null,
		task_summary: summary,
	});
}

// =====================================================================
// complete_wave
// =====================================================================

export function handleCompleteWave(args: Record<string, unknown> | undefined): ToolResult {
	let waveNum: number;
	let activeSpec: ReturnType<typeof getActiveSpecOnDisk>;
	let commitRange: string;
	try {
		waveNum = requireWaveNum(args);
		activeSpec = getActiveSpecOnDisk();
		const r = args?.commit_range;
		if (typeof r !== "string" || !/^[0-9a-f]{4,40}\.\.[0-9a-f]{4,40}$/.test(r)) {
			return errorResult("missing or malformed commit_range (expected 'startSha..endSha')");
		}
		commitRange = r;
	} catch (err) {
		return errorResult((err as Error).message);
	}
	if (activeSpec === null) {
		return errorResult("no active spec");
	}

	const wavePathStr = wavePath(activeSpec.name, waveNum);
	if (!existsSync(wavePathStr)) {
		return errorResult(`wave-${pad(waveNum)}.md not found; run /qult:wave-start first`);
	}

	let waveDoc: ReturnType<typeof parseWaveMd>;
	try {
		waveDoc = parseWaveMd(readText(wavePathStr));
	} catch (err) {
		return errorResult(`wave-${pad(waveNum)}.md is malformed: ${(err as Error).message}`);
	}
	if (waveDoc.num !== waveNum) {
		return errorResult(
			`wave-${pad(waveNum)}.md header reports Wave ${waveDoc.num}; refusing to mutate a corrupted file`,
		);
	}
	if (waveDoc.completedAt) {
		return jsonResult({
			ok: false,
			reason: "already_completed",
			completed_at: waveDoc.completedAt,
		});
	}

	// Cross-check: the start SHA in commit_range must match the Start commit
	// recorded by /qult:wave-start (in Notes), so an architect can't paste an
	// arbitrary range that happens to be reachable.
	const rangeMatch = /^([0-9a-f]{4,40})\.\.([0-9a-f]{4,40})$/.exec(commitRange);
	const requestedStart = rangeMatch?.[1] ?? "";
	const recordedStart = extractStartCommit(waveDoc.notes);
	if (recordedStart && !shasEquivalent(recordedStart, requestedStart)) {
		return jsonResult({
			ok: false,
			reason: "range_start_mismatch",
			recorded_start: recordedStart,
			requested_start: requestedStart,
		});
	}

	// Range integrity: every prior wave's range SHAs must still be reachable.
	const stale: string[] = [];
	for (const prior of listWaveNumbers(activeSpec.name)) {
		if (prior === waveNum) continue;
		const priorPath = wavePath(activeSpec.name, prior);
		if (!existsSync(priorPath)) continue;
		let priorDoc: ReturnType<typeof parseWaveMd>;
		try {
			priorDoc = parseWaveMd(readText(priorPath));
		} catch {
			stale.push(`wave-${pad(prior)} (malformed)`);
			continue;
		}
		if (!priorDoc.range) continue;
		const m = /^([0-9a-f]{4,40})\.\.([0-9a-f]{4,40})$/.exec(priorDoc.range);
		if (!m) continue;
		if (!isCommitReachable(m[1]!, projectRoot()) || !isCommitReachable(m[2]!, projectRoot())) {
			stale.push(`wave-${pad(prior)}`);
		}
	}
	if (stale.length > 0) {
		return jsonResult({ ok: false, reason: "sha_unreachable", stale });
	}

	// All checks pass — finalize this wave file.
	waveDoc = {
		...waveDoc,
		completedAt: new Date().toISOString(),
		range: commitRange,
	};
	atomicWrite(wavePathStr, writeWaveMd(waveDoc));
	return jsonResult({ ok: true, range: commitRange });
}

function extractStartCommit(notes: string): string | null {
	const m = /\*\*Start commit\*\*:\s*([0-9a-f]{4,40})/.exec(notes);
	return m?.[1] ?? null;
}

function shasEquivalent(a: string, b: string): boolean {
	if (!a || !b) return false;
	const min = Math.min(a.length, b.length);
	if (min < 4) return false;
	return a.slice(0, min).toLowerCase() === b.slice(0, min).toLowerCase();
}

function projectRoot(): string {
	return getProjectRoot();
}

// =====================================================================
// update_task_status
// =====================================================================

export function handleUpdateTaskStatus(args: Record<string, unknown> | undefined): ToolResult {
	let activeSpec: ReturnType<typeof getActiveSpecOnDisk>;
	const taskId = typeof args?.task_id === "string" ? args.task_id : null;
	const statusRaw = typeof args?.status === "string" ? args.status : null;
	if (!taskId) return errorResult("missing task_id");
	if (!statusRaw || !["pending", "in_progress", "done", "blocked"].includes(statusRaw)) {
		return errorResult("status must be one of: pending | in_progress | done | blocked");
	}
	try {
		activeSpec = getActiveSpecOnDisk();
	} catch (err) {
		return errorResult((err as Error).message);
	}
	if (activeSpec === null) return errorResult("no active spec");

	const tasksFile = tasksPath(activeSpec.name);
	if (!existsSync(tasksFile)) return errorResult("tasks.md not found");

	// Reject status flips on tasks belonging to an already-completed Wave —
	// Range / wave-NN.md immutability is the basis for reviewer trust.
	const waveMatch = /^T(\d+)\./.exec(taskId);
	if (waveMatch?.[1]) {
		const taskWaveNum = Number.parseInt(waveMatch[1], 10);
		if (Number.isInteger(taskWaveNum) && taskWaveNum >= 1 && taskWaveNum <= 99) {
			const taskWavePath = wavePath(activeSpec.name, taskWaveNum);
			if (existsSync(taskWavePath)) {
				try {
					const taskWaveDoc = parseWaveMd(readText(taskWavePath));
					if (taskWaveDoc.completedAt) {
						return jsonResult({
							ok: false,
							reason: "wave_completed",
							wave_num: taskWaveNum,
							completed_at: taskWaveDoc.completedAt,
						});
					}
				} catch {
					// Treat malformed wave-NN.md as not-completed (architect can fix it manually).
				}
			}
		}
	}

	let updated: string;
	try {
		updated = setTaskStatus(readText(tasksFile), taskId, statusRaw as TaskStatus);
	} catch (err) {
		if ((err as Error).name === "TaskNotFoundError") {
			return jsonResult({ ok: false, reason: "task_not_found", task_id: taskId });
		}
		return errorResult((err as Error).message);
	}
	atomicWrite(tasksFile, updated);
	return jsonResult({ ok: true, task_id: taskId, status: statusRaw });
}

// =====================================================================
// archive_spec  (replaces archive_plan)
// =====================================================================

export function handleArchiveSpec(args: Record<string, unknown> | undefined): ToolResult {
	let name: string;
	try {
		name = requireSpecName(args);
	} catch (err) {
		return errorResult((err as Error).message);
	}
	const force = args?.force === true;
	// Refuse to archive a spec with unfinished Waves unless explicitly forced.
	// Without this guard a buggy/confused caller could silently archive an
	// in-progress spec, leaving the architect with no active context.
	if (!force) {
		const pending: string[] = [];
		try {
			for (const num of listWaveNumbers(name)) {
				const p = wavePath(name, num);
				if (!existsSync(p)) continue;
				const doc = parseWaveMd(readText(p));
				if (!doc.completedAt) pending.push(`wave-${pad(num)}`);
			}
		} catch {
			// If we can't read waves/, fall through and let archiveSpecOnDisk decide.
		}
		if (pending.length > 0) {
			return jsonResult({
				ok: false,
				reason: "spec_not_finished",
				pending_waves: pending,
				hint: "pass { force: true } to archive anyway",
			});
		}
	}
	try {
		const dest = archiveSpecOnDisk(name);
		return jsonResult({ ok: true, archived_to: dest });
	} catch (err) {
		return errorResult((err as Error).message);
	}
}

// =====================================================================
// record_spec_evaluator_score
// =====================================================================

export function handleRecordSpecEvaluatorScore(
	args: Record<string, unknown> | undefined,
): ToolResult {
	const phase = args?.phase;
	const total = args?.total;
	const dim = args?.dim_scores;
	const forced = args?.forced_progress ?? false;
	const iter = args?.iteration ?? 1;
	if (phase !== "requirements" && phase !== "design" && phase !== "tasks") {
		return errorResult("phase must be one of: requirements | design | tasks");
	}
	if (typeof total !== "number" || total < 0 || total > 20) {
		return errorResult("total must be a number in [0, 20]");
	}
	if (!dim || typeof dim !== "object") {
		return errorResult("dim_scores must be an object");
	}
	const dimRecord: Record<string, number> = {};
	for (const [k, v] of Object.entries(dim as Record<string, unknown>)) {
		if (typeof v === "number") dimRecord[k] = v;
	}
	if (typeof iter !== "number" || iter < 1) {
		return errorResult("iteration must be a positive integer");
	}
	if (typeof forced !== "boolean") {
		return errorResult("forced_progress must be a boolean");
	}
	// Auto-reset spec_eval when the active spec name has changed since the last
	// recorded score, so the previous spec's scores never leak into a new spec.
	let activeName: string | null = null;
	try {
		activeName = getActiveSpecOnDisk()?.name ?? null;
	} catch {
		activeName = null;
	}
	const cur = readStageScores();
	if (activeName !== null && cur.spec_name !== activeName) {
		resetSpecEval(activeName);
	}
	const state = recordSpecEvalPhase(phase as SpecEvalPhase, {
		total,
		dim_scores: dimRecord,
		forced_progress: forced,
		iteration: iter,
	});
	return jsonResult({
		ok: true,
		phase,
		spec_name: activeName,
		recorded: state.spec_eval[phase as SpecEvalPhase],
	});
}

// =====================================================================
// /qult:wave-start helper (used by skill, not exposed as a separate MCP tool)
// =====================================================================

/**
 * Initialize wave-NN.md for a fresh Wave with the current HEAD as start commit.
 * Exported so the wave-start skill can call it if we later expose a tool for it.
 */
export function initWaveFile(opts: {
	specName: string;
	waveNum: number;
	title: string;
	goal: string;
	verify: string;
	scaffold?: boolean;
	fixes?: number | null;
	/** When true, overwrite an existing in-progress wave-NN.md instead of refusing. */
	force?: boolean;
}): { path: string; reused: boolean } {
	const file = wavePathEnsured(opts.specName, opts.waveNum);
	// If wave-NN.md already exists with `Started at` and no `Completed at`,
	// refuse to overwrite — this would silently lose the recorded start commit
	// and stale the eventual Range.
	if (existsSync(file) && !opts.force) {
		try {
			const existing = parseWaveMd(readText(file));
			if (existing.startedAt && !existing.completedAt) {
				throw new Error(
					`wave-${pad(opts.waveNum)}.md is already started (start: ${existing.startedAt}); ` +
						`re-running /qult:wave-start would lose the recorded Start commit. ` +
						`Pass force=true to overwrite, or use the existing wave file.`,
				);
			}
			if (existing.completedAt) {
				throw new Error(
					`wave-${pad(opts.waveNum)}.md is already completed (range: ${existing.range ?? "?"}); ` +
						`do not re-start a completed Wave.`,
				);
			}
		} catch (err) {
			if ((err as Error).message.startsWith("malformed wave-NN.md")) {
				// Malformed: allow overwrite to recover.
			} else {
				throw err;
			}
		}
	}
	const head = gitHeadSha();
	const now = new Date().toISOString();
	const doc = newWaveDoc({
		num: opts.waveNum,
		title: opts.title,
		goal: opts.goal,
		verify: opts.verify,
		scaffold: opts.scaffold,
		fixes: opts.fixes ?? null,
		startedAt: now,
	});
	doc.notes = `**Start commit**: ${head}`;
	atomicWrite(file, writeWaveMd(doc));
	return { path: file, reused: false };
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}
