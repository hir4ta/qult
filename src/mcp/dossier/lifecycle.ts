import { execFile } from "node:child_process";
import { clearReviewGate, readReviewGate, writeReviewGate } from "../../hooks/review-gate.js";
import { shouldAutoAppend } from "../../hooks/lang-filter.js";
import { readWaveProgress, writeWaveProgress } from "../../hooks/state.js";
import { updateTaskStatus } from "../../spec/status.js";
import type { SpecSize, SpecType, TasksFile } from "../../spec/types.js";
import {
	cancelTask,
	closingWave,
	completeTask,
	effectiveStatus,
	implWaves,
	parseTasksFile,
	readActive,
	readActiveState,
	SpecDir,
	writeActiveState,
} from "../../spec/types.js";
import { validateSpec } from "../../spec/validate.js";
import type { Store } from "../../store/index.js";
import { truncate } from "../helpers.js";
import { type DossierParams, errorResult, jsonResult } from "./helpers.js";

/**
 * FR-1: Collect source files changed during spec lifetime via git log.
 * Uses started_at from _active.json as the time boundary.
 * Timeout: 3s, returns empty array on failure.
 */
function getChangedFilesForSpec(projectPath: string, startedAt: string): Promise<string[]> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["log", "--diff-filter=ACMR", "--name-only", `--since=${startedAt}`, "--pretty=format:"],
			{ cwd: projectPath, timeout: 3000 },
			(err, stdout) => {
				if (err) {
					if (err.killed) {
						process.stderr.write("[alfred] git log timed out collecting changed files\n");
					}
					resolve([]);
					return;
				}
				const files = [...new Set(
					stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && shouldAutoAppend(l)),
				)];
				resolve(files);
			},
		);
	});
}

export async function dossierComplete(projectPath: string, store: Store, params: DossierParams) {
	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	const state = readActiveState(projectPath);
	const task = state.tasks.find((t) => t.slug === taskSlug);

	// Validation gate: all sizes must pass validation (no fail checks).
	// Two failure modes: (1) validateSpec returns fails → block completion.
	// (2) validateSpec throws → fail-open, allow completion (NFR-2).
	try {
		const valSize = (task?.size ?? "L") as SpecSize;
		const valSpecType = (task?.spec_type ?? "feature") as SpecType;
		const valResult = validateSpec(projectPath, taskSlug, valSize, valSpecType, { strict: true });
		if (valResult.failed > 0) {
			const errors = valResult.checks.filter((c) => c.status === "fail").map((c) => c.message);
			return errorResult(
				`validation gate: ${valResult.failed} check(s) failed. Fix before completing.\n${errors.join("\n")}`,
			);
		}
	} catch {
		/* fail-open: validation errors don't block completion */
	}

	// Check ALL wave tasks — DENY if unchecked items remain (#24).
	try {
		const sd = new SpecDir(projectPath, taskSlug);
		const tasksData = parseTasksFile(sd.readFile("tasks.json"));
		const wavesError = checkAllWaveTasks(tasksData);
		if (wavesError) return errorResult(`task completion gate: ${wavesError}`);
		const closingError = checkClosingWave(tasksData);
		if (closingError) return errorResult(`closing wave gate: ${closingError}`);
	} catch {
		/* tasks.json may not exist for all sizes */
	}

	try {
		// FR-1: Collect changed files for rework rate tracking.
		let changedFiles: string[] = [];
		if (task?.started_at) {
			changedFiles = await getChangedFilesForSpec(projectPath, task.started_at);
		}

		const currentStatus = effectiveStatus(task?.status);
		const newPrimary = completeTask(projectPath, taskSlug);
		// design.md pattern auto-extraction removed (FR-6).
		// Knowledge accumulation happens intentionally at Wave boundaries via ledger.

		const result: Record<string, unknown> = {
			task_slug: taskSlug,
			completed: true,
			new_primary: newPrimary,
		};
		// Prompt Claude to save additional patterns/rules via ledger.
		result.knowledge_prompt =
			"Task completed. Save reusable learnings via `ledger action=save sub_type=pattern`. " +
			"Consider: implementation approaches that worked, error patterns encountered, testing strategies, " +
			"architectural decisions that should become rules.";

		return jsonResult(result);
	} catch (err) {
		return errorResult(`${err}`);
	}
}

/**
 * Check that ALL implementation Wave tasks (excluding Closing) are checked.
 */
function checkAllWaveTasks(tasksData: TasksFile): string | undefined {
	const uncheckedByWave: Array<{ wave: string; count: number }> = [];

	for (const wave of implWaves(tasksData)) {
		const unchecked = wave.tasks.filter(t => !t.checked).length;
		if (unchecked > 0) {
			uncheckedByWave.push({ wave: `${wave.title}`, count: unchecked });
		}
	}

	if (uncheckedByWave.length === 0) return undefined;

	const total = uncheckedByWave.reduce((s, w) => s + w.count, 0);
	const details = uncheckedByWave.map(w => `${w.wave}: ${w.count}`).join(", ");
	return `${total} unchecked task(s) in implementation waves (${details}). Check all tasks via \`dossier action=check task_id="T-X.Y"\` before completing.`;
}

/**
 * Check that ALL Closing Wave items are checked.
 */
function checkClosingWave(tasksData: TasksFile): string | undefined {
	const cw = closingWave(tasksData);
	if (!cw) {
		return "No Closing wave found in tasks.json.";
	}

	const unchecked = cw.tasks.filter(t => !t.checked);
	if (unchecked.length > 0) {
		const items = unchecked.map(t => t.title).join(", ");
		return `Closing Wave has ${unchecked.length} unchecked item(s): ${items}. Check all items via \`dossier action=check task_id="T-C.N"\` before completing.`;
	}

	return undefined;
}

export function dossierGate(projectPath: string, params: DossierParams) {
	const subAction = params.sub_action;
	if (!subAction) return errorResult("sub_action is required for gate (set/clear/status)");

	switch (subAction) {
		case "set": {
			const gateType = params.gate_type;
			if (gateType !== "spec-review" && gateType !== "wave-review") {
				return errorResult('gate_type must be "spec-review" or "wave-review"');
			}
			if (gateType === "wave-review" && (params.wave == null || params.wave < 1)) {
				return errorResult("wave (number >= 1) is required for wave-review gate");
			}

			let taskSlug = params.task_slug;
			if (!taskSlug) {
				try {
					taskSlug = readActive(projectPath);
				} catch (err) {
					return errorResult(`no active spec: ${err}`);
				}
			}

			const gateReason =
				params.reason ??
				(gateType === "spec-review"
					? "Spec review required."
					: `Wave ${params.wave} review required.`);

			writeReviewGate(projectPath, {
				gate: gateType,
				slug: taskSlug,
				wave: gateType === "wave-review" ? params.wave : undefined,
				reason: gateReason,
			});


			return jsonResult({
				gate: gateType,
				slug: taskSlug,
				wave: params.wave,
				set: true,
			});
		}

		case "clear": {
			if (!params.reason || params.reason.trim().length < 30) {
				return errorResult(
					'reason must be at least 30 characters — include: review method (code-reviewer/inspect/manual), findings count (Critical/High/Medium), and fix summary. Example: "code-reviewer: 0 Critical, 2 Medium fixed (regex normalization, error message)"',
				);
			}

			const gate = readReviewGate(projectPath);
			if (!gate) {
				return jsonResult({ cleared: false, reason: "no active review gate to clear" });
			}

			// FR-9: Block gate clear if fix_mode is active but no re-review was performed.
			if (gate.fix_mode && !gate.re_reviewed) {
				return errorResult(
					"fix_mode で修正後、レビューを再実行してから gate clear してください。" +
					"alfred:code-reviewer agent または /alfred:inspect でレビューを実行し、" +
					"その後 dossier action=gate sub_action=clear を再度呼んでください。",
				);
			}

			const reason = truncate(params.reason, 500);
			clearReviewGate(projectPath);

			// FR-15: Auto-transition review → in-progress on gate clear.
			if (gate.slug) {
				try {
					updateTaskStatus(projectPath, gate.slug, "in-progress", "auto:gate-clear");
				} catch { /* ignore: task may not be in review state */ }
			}

			// FR-1: Update wave-progress reviewed flag on wave-review gate clear.
			if (gate.gate === "wave-review" && gate.wave !== undefined) {
				try {
					const progress = readWaveProgress(projectPath);
					const waveKey = String(gate.wave);
					if (progress?.waves[waveKey]) {
						progress.waves[waveKey]!.reviewed = true;
						writeWaveProgress(projectPath, progress);
					}
				} catch { /* fail-open */ }
			}


			return jsonResult({ cleared: true, reason });
		}

		case "fix": {
			// Enter fix_mode: allows Edit/Write while keeping gate logically active (#15/#20).
			// After applying fixes, re-run review then `gate clear` to fully remove.
			const gate = readReviewGate(projectPath);
			if (!gate) {
				return jsonResult({ fix_mode: false, reason: "no active review gate" });
			}
			if (gate.fix_mode) {
				return jsonResult({ fix_mode: true, reason: "already in fix mode" });
			}

			const fixReason = params.reason ? truncate(params.reason, 500) : "Applying review fixes";
			writeReviewGate(projectPath, {
				...gate,
				fix_mode: true,
				fix_mode_at: new Date().toISOString(),
				re_reviewed: false,
				re_reviewed_at: undefined,
				reason: `[fix_mode] ${fixReason} (original: ${gate.reason})`,
			});


			return jsonResult({
				fix_mode: true,
				slug: gate.slug,
				reason: fixReason,
				hint: "Edit/Write now allowed. After fixes, re-run review then `dossier gate clear reason=\"re-review: 0 Critical\"` to fully clear.",
			});
		}

		case "status": {
			const gate = readReviewGate(projectPath);
			if (!gate) return jsonResult({ gate: null });
			return jsonResult(gate);
		}

		default:
			return errorResult(`unknown gate sub_action: ${subAction} (valid: set/clear/fix/status)`);
	}
}

// --- Check (task completion) ---

export function dossierCheck(projectPath: string, params: DossierParams) {
	const taskId = params.task_id;
	if (!taskId) return errorResult("task_id is required for check (e.g. 'T-1.2')");

	let taskSlug: string;
	try {
		taskSlug = readActive(projectPath);
	} catch {
		return errorResult("no active spec");
	}

	const sd = new SpecDir(projectPath, taskSlug);
	let tasksData: TasksFile;
	try {
		tasksData = parseTasksFile(sd.readFile("tasks.json"));
	} catch {
		return errorResult("tasks.json not found or invalid");
	}

	// Find the task by ID across all waves (including closing)
	let found = false;
	let alreadyChecked = false;

	for (const wave of tasksData.waves) {
		for (const task of wave.tasks) {
			if (task.id.toLowerCase() === taskId.toLowerCase()) {
				if (task.checked) {
					alreadyChecked = true;
				} else {
					task.checked = true;
					found = true;
				}
				break;
			}
		}
		if (found || alreadyChecked) break;
	}

	if (alreadyChecked) {
		return jsonResult({ task_id: taskId, status: "already_checked", task_slug: taskSlug });
	}
	if (!found) {
		return errorResult(`task_id "${taskId}" not found in tasks.json`);
	}

	// Dependency check: warn if this task's depends are not all checked.
	const depWarnings: string[] = [];
	const checkedTask = findTaskById(tasksData, taskId);
	if (checkedTask?.depends && checkedTask.depends.length > 0) {
		const allTaskMap = new Map(
			tasksData.waves.flatMap((w) => w.tasks).map((t) => [t.id.toLowerCase(), t]),
		);
		for (const depId of checkedTask.depends) {
			const dep = allTaskMap.get(depId.toLowerCase());
			if (dep && !dep.checked) {
				depWarnings.push(`dependency ${dep.id} ("${dep.title}") is not yet checked`);
			}
		}
	}

	// Write back
	sd.writeFile("tasks.json", JSON.stringify(tasksData, null, 2) + "\n");

	// Detect wave completion
	const waveMessages: string[] = [];
	for (const wave of tasksData.waves) {
		if (wave.tasks.every(t => t.checked) && wave.tasks.length > 0) {
			const label = wave.key === "closing" ? "Closing" : `Wave ${wave.key}`;
			const total = wave.tasks.length;
			waveMessages.push(
				`${label} complete (${total}/${total} tasks). You MUST now: 1) Commit your changes, 2) Run self-review (delegate to alfred:code-reviewer or /alfred:inspect), 3) Save any learnings via \`ledger save\`. Then clear the gate with \`dossier action=gate sub_action=clear reason="..."\`.`
			);
		}
	}

	return jsonResult({
		task_id: taskId,
		status: "checked",
		task_slug: taskSlug,
		...(depWarnings.length > 0 ? { dep_warnings: depWarnings } : {}),
		...(waveMessages.length > 0 ? { wave_completion: waveMessages } : {}),
	});
}

// --- Defer / Cancel ---

export function dossierDefer(projectPath: string, params: DossierParams) {
	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	const state = readActiveState(projectPath);
	const task = state.tasks.find((t) => t.slug === taskSlug);
	if (!task) return errorResult(`task "${taskSlug}" not found`);

	const current = effectiveStatus(task.status);

	// Toggle: deferred → in-progress, otherwise → deferred
	if (current === "deferred") {
		try {
			updateTaskStatus(projectPath, taskSlug, "in-progress", "dossier:defer");
		} catch (err) {
			return errorResult(`${err}`);
		}
		return jsonResult({ task_slug: taskSlug, status: "in-progress", resumed: true });
	}

	try {
		updateTaskStatus(projectPath, taskSlug, "deferred", "dossier:defer");
	} catch (err) {
		return errorResult(`${err}`);
	}
	return jsonResult({ task_slug: taskSlug, status: "deferred", deferred: true });
}

export function dossierCancel(projectPath: string, params: DossierParams) {
	let taskSlug = params.task_slug;
	if (!taskSlug) {
		try {
			taskSlug = readActive(projectPath);
		} catch (err) {
			return errorResult(`no active spec: ${err}`);
		}
	}

	try {
		cancelTask(projectPath, taskSlug);
	} catch (err) {
		return errorResult(`${err}`);
	}

	return jsonResult({ task_slug: taskSlug, status: "cancelled", cancelled: true });
}

// --- Helpers ---

import type { SpecTask, TasksFile as TF } from "../../spec/types.js";

function findTaskById(tasksData: TF, taskId: string): SpecTask | undefined {
	const lower = taskId.toLowerCase();
	for (const wave of tasksData.waves) {
		for (const task of wave.tasks) {
			if (task.id.toLowerCase() === lower) return task;
		}
	}
	return undefined;
}

/**
 * Get tasks that are ready to work on: unchecked and all depends satisfied.
 * Useful for identifying parallelizable work within a wave.
 */
export function getReadyTasks(tasksData: TF): SpecTask[] {
	const checkedIds = new Set(
		tasksData.waves
			.flatMap((w) => w.tasks)
			.filter((t) => t.checked)
			.map((t) => t.id.toLowerCase()),
	);

	return tasksData.waves
		.flatMap((w) => w.tasks)
		.filter((t) => {
			if (t.checked) return false;
			if (!t.depends || t.depends.length === 0) return true;
			return t.depends.every((d) => checkedIds.has(d.toLowerCase()));
		});
}

/**
 * Detect circular dependencies in tasks via topological sort.
 * Returns array of task IDs involved in cycles, or empty if no cycles.
 */
export function detectCyclicDeps(tasksData: TF): string[] {
	const allTasks = tasksData.waves.flatMap((w) => w.tasks);
	const idSet = new Set(allTasks.map((t) => t.id.toLowerCase()));
	const adj = new Map<string, string[]>();
	for (const t of allTasks) {
		const deps = (t.depends ?? []).filter((d) => idSet.has(d.toLowerCase()));
		adj.set(t.id.toLowerCase(), deps.map((d) => d.toLowerCase()));
	}

	// Kahn's algorithm
	const inDegree = new Map<string, number>();
	for (const id of idSet) inDegree.set(id, 0);
	for (const [, deps] of adj) {
		for (const d of deps) {
			inDegree.set(d, (inDegree.get(d) ?? 0) + 1);
		}
	}

	const queue = [...idSet].filter((id) => inDegree.get(id) === 0);
	const sorted: string[] = [];
	while (queue.length > 0) {
		const node = queue.shift()!;
		sorted.push(node);
		for (const dep of adj.get(node) ?? []) {
			const newDeg = (inDegree.get(dep) ?? 1) - 1;
			inDegree.set(dep, newDeg);
			if (newDeg === 0) queue.push(dep);
		}
	}

	// Nodes not in sorted = in cycles
	const sortedSet = new Set(sorted);
	return [...idSet].filter((id) => !sortedSet.has(id));
}
