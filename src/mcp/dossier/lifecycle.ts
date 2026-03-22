import { execFile } from "node:child_process";
import { clearReviewGate, readReviewGate, writeReviewGate } from "../../hooks/review-gate.js";
import { shouldAutoAppend } from "../../hooks/lang-filter.js";
import { ensureStateDir, readWaveProgress, writeStateJSON, writeWaveProgress } from "../../hooks/state.js";
import { appendAudit } from "../../spec/audit.js";
import { updateTaskStatus } from "../../spec/status.js";
import type { SpecSize, SpecType } from "../../spec/types.js";
import {
	completeTask,
	effectiveStatus,
	readActive,
	readActiveState,
	reviewStatusFor,
	SpecDir,
	verifyReviewFile,
	writeActiveState,
} from "../../spec/types.js";
import { validateSpec } from "../../spec/validate.js";
import type { Store } from "../../store/index.js";
import { truncate } from "../helpers.js";
import { type DossierParams, errorResult, jsonResult } from "./helpers.js";

/**
 * FR-1: Collect source files changed during spec lifetime via git log.
 * Uses started_at from _active.md as the time boundary.
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

function ensurePolishState(projectPath: string, slug: string): void {
	ensureStateDir(projectPath);
	writeStateJSON(projectPath, "polish.json", {
		slug,
		completed_at: new Date().toISOString(),
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

	// Approval gate for M+ specs.
	const state = readActiveState(projectPath);
	const task = state.tasks.find((t) => t.slug === taskSlug);
	if (task) {
		const size = task.size ?? "L";
		if (["M", "L"].includes(size)) {
			const reviewStatus = reviewStatusFor(projectPath, taskSlug);
			if (reviewStatus !== "approved") {
				return errorResult(
					`completion requires review_status="approved" for ${size} specs (current: "${reviewStatus || "pending"}"). Review in alfred dashboard.`,
				);
			}
			// Verify review JSON file exists with approved status (FR-1).
			const verification = verifyReviewFile(projectPath, taskSlug);
			if (!verification.valid) {
				return errorResult(`approval gate: ${verification.reason}. Review in alfred dashboard.`);
			}
		}
	}

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
		const tasksContent = sd.readFile("tasks.md");
		const wavesError = checkAllWaveTasks(tasksContent);
		if (wavesError) return errorResult(`task completion gate: ${wavesError}`);
		const closingError = checkClosingWave(tasksContent);
		if (closingError) return errorResult(`closing wave gate: ${closingError}`);
	} catch {
		/* tasks.md may not exist for all sizes */
	}

	try {
		// FR-1: Collect changed files for rework rate tracking.
		let changedFiles: string[] = [];
		if (task?.started_at) {
			changedFiles = await getChangedFilesForSpec(projectPath, task.started_at);
		}

		const currentStatus = effectiveStatus(task?.status);
		const newPrimary = completeTask(projectPath, taskSlug);
		appendAudit(projectPath, {
			action: "spec.complete",
			target: taskSlug,
			user: "mcp",
			detail: JSON.stringify({ changed_files: changedFiles, size: task?.size ?? "M" }),
		});
		appendAudit(projectPath, {
			action: "task.status_change",
			target: taskSlug,
			detail: `${currentStatus} → done (dossier:complete)`,
		});
		// design.md pattern auto-extraction removed (FR-6).
		// Knowledge accumulation happens intentionally at Wave boundaries via ledger.

		// Enable polish mode — allows edits without a new spec
		try {
			ensurePolishState(projectPath, taskSlug);
		} catch {
			/* best-effort */
		}

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
 * Check that ALL Wave tasks (excluding Closing Wave) are checked.
 * Returns error message listing unchecked items if any, undefined if all done.
 * Fixes #24: dossier complete was only checking Closing Wave.
 */
function checkAllWaveTasks(tasksContent: string): string | undefined {
	const lines = tasksContent.split("\n");
	const uncheckedByWave: Array<{ wave: string; count: number }> = [];
	let currentWave: string | null = null;
	let isClosing = false;

	for (const line of lines) {
		// Detect wave headers: "## Wave 1: ...", "## Wave 2", etc.
		const waveMatch = line.match(/^## Wave[:\s]*(\d+[\w\s:：—-]*)/i);
		if (waveMatch) {
			currentWave = waveMatch[1]!.trim();
			isClosing = false;
			continue;
		}
		// Detect Closing Wave header — stop counting
		if (/^## (?:Wave:\s*)?[Cc]losing(?:\s+[Ww]ave)?/i.test(line)) {
			currentWave = null;
			isClosing = true;
			continue;
		}
		// Stop at next ## section after closing
		if (line.startsWith("## ") && isClosing) {
			isClosing = false;
			continue;
		}
		// Count unchecked items in non-Closing waves
		if (currentWave && /^- \[ \] /.test(line)) {
			const existing = uncheckedByWave.find((w) => w.wave === currentWave);
			if (existing) {
				existing.count++;
			} else {
				uncheckedByWave.push({ wave: currentWave, count: 1 });
			}
		}
	}

	if (uncheckedByWave.length === 0) return undefined;

	const total = uncheckedByWave.reduce((s, w) => s + w.count, 0);
	const details = uncheckedByWave.map((w) => `Wave ${w.wave}: ${w.count}`).join(", ");
	return `${total} unchecked task(s) in implementation waves (${details}). Check all tasks via \`dossier action=check task_id="T-X.Y"\` before completing.`;
}

/**
 * Check that ALL Closing Wave items are checked.
 * Returns error message listing unchecked items if any, undefined if all done.
 */
function checkClosingWave(tasksContent: string): string | undefined {
	const closingIdx = tasksContent.search(/## (?:Wave:\s*)?[Cc]losing(?:\s+[Ww]ave)?/i);
	if (closingIdx === -1)
		return "No Closing Wave found in tasks.md. Add self-review, CLAUDE.md update, and test verification items.";

	const closingSection = tasksContent.slice(closingIdx);
	const nextSection = closingSection.indexOf("\n##", 1);
	const body = nextSection === -1 ? closingSection : closingSection.slice(0, nextSection);

	const uncheckedItems = body.match(/^- \[ \] .+$/gm);
	if (uncheckedItems && uncheckedItems.length > 0) {
		const items = uncheckedItems.map((line) => line.replace(/^- \[ \] /, "").trim()).join(", ");
		return `Closing Wave has ${uncheckedItems.length} unchecked item(s): ${items}. Check all items via \`dossier action=check task_id="T-C.N"\` before completing.`;
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

			appendAudit(projectPath, {
				action: "gate.set",
				target: taskSlug,
				detail: `${gateType}${params.wave ? ` wave=${params.wave}` : ""}`,
				user: "mcp",
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

			appendAudit(projectPath, {
				action: "gate.clear",
				target: gate.slug,
				detail: reason,
				user: "mcp",
			});

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
				reason: `[fix_mode] ${fixReason} (original: ${gate.reason})`,
			});

			appendAudit(projectPath, {
				action: "gate.fix",
				target: gate.slug,
				detail: fixReason,
				user: "mcp",
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
	let tasks: string;
	try {
		tasks = sd.readFile("tasks.md");
	} catch {
		return errorResult("tasks.md not found");
	}

	const lines = tasks.split("\n");
	let checked = false;
	const taskIdLower = taskId.toLowerCase();

	// T-C.N format: match Nth unchecked checkbox in Closing Wave section.
	const closingMatch = taskId.match(/^T-C\.(\d+)$/i);
	if (closingMatch) {
		const nth = parseInt(closingMatch[1]!, 10);
		let inClosing = false;
		let closingIndex = 0;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (/^## (?:Wave:\s*)?[Cc]losing(?:\s+[Ww]ave)?/i.test(line)) {
				inClosing = true;
				continue;
			}
			if (inClosing && line.startsWith("## ")) break; // Left Closing section
			if (inClosing && line.match(/^- \[[ xX]\] /)) {
				closingIndex++;
				if (closingIndex === nth) {
					if (/^- \[[xX]\] /.test(line)) {
						return jsonResult({ task_id: taskId, status: "already_checked" });
					}
					lines[i] = line.replace("- [ ]", "- [x]");
					checked = true;
					break;
				}
			}
		}
		if (!checked && closingIndex < nth) {
			return errorResult(`task_id "${taskId}" not found: Closing Wave has only ${closingIndex} item(s)`);
		}
	} else {
		// Standard T-N.N format: match by text inclusion in checkbox line.
		// Also supports T-N.R: find `### T-N.R` header → check the first checkbox below it.
		const reviewHeaderMatch = taskId.match(/^T-\d+\.R$/i);
		if (reviewHeaderMatch) {
			const headerPattern = new RegExp(`^###\\s+${taskId.replace(".", "\\.")}\\b`, "i");
			let foundHeader = false;
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (headerPattern.test(line)) {
					foundHeader = true;
					continue;
				}
				if (foundHeader && /^- \[ \] /.test(line)) {
					lines[i] = line.replace("- [ ]", "- [x]");
					checked = true;
					break;
				}
				if (foundHeader && /^- \[[xX]\] /.test(line)) {
					return jsonResult({ task_id: taskId, status: "already_checked" });
				}
				if (foundHeader && /^##[# ]/.test(line)) break; // Left section
			}
			if (!checked && !foundHeader) {
				return errorResult(`task_id "${taskId}" not found in tasks.md`);
			}
		} else {
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (line.match(/^- \[ \] /) && line.toLowerCase().includes(taskIdLower)) {
					lines[i] = line.replace("- [ ]", "- [x]");
					checked = true;
					break;
				}
			}

			if (!checked) {
				const alreadyChecked = lines.some(
					(l) => /^- \[[xX]\] /.test(l) && l.toLowerCase().includes(taskIdLower),
				);
				if (alreadyChecked) {
					return jsonResult({ task_id: taskId, status: "already_checked" });
				}
				return errorResult(`task_id "${taskId}" not found in tasks.md`);
			}
		}
	}

	const updatedContent = lines.join("\n");
	sd.writeFile("tasks.md", updatedContent);

	// Detect wave completion (reuse logic from post-tool).
	const waveMessages: string[] = [];
	try {
		const { detectWaveCompletion } = require("../../hooks/post-tool.js");
		const waveItems = detectWaveCompletion(projectPath, taskSlug, updatedContent);
		for (const item of waveItems) {
			waveMessages.push(item.message);
		}
	} catch {
		/* wave detection is optional */
	}

	return jsonResult({
		task_id: taskId,
		status: "checked",
		task_slug: taskSlug,
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
		updateTaskStatus(projectPath, taskSlug, "cancelled", "dossier:cancel");
	} catch (err) {
		return errorResult(`${err}`);
	}

	// Move primary to next non-terminal task.
	const state = readActiveState(projectPath);
	if (state.primary === taskSlug) {
		state.primary = state.tasks.find((t) => {
			const s = effectiveStatus(t.status);
			return s !== "done" && s !== "cancelled" && t.slug !== taskSlug;
		})?.slug ?? "";
		writeActiveState(projectPath, state);
	}

	return jsonResult({ task_slug: taskSlug, status: "cancelled", cancelled: true });
}
