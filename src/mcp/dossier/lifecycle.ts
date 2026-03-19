import { syncTaskStatus } from "../../epic/index.js";
import { clearReviewGate, readReviewGate, writeReviewGate } from "../../hooks/review-gate.js";
import { readWaveProgress, writeWaveProgress } from "../../hooks/state.js";
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

export function dossierComplete(projectPath: string, store: Store, params: DossierParams) {
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
		if (["M", "L", "XL"].includes(size)) {
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

	// Check closing wave completion — DENY if unchecked items remain.
	try {
		const sd = new SpecDir(projectPath, taskSlug);
		const tasksContent = sd.readFile("tasks.md");
		const closingError = checkClosingWave(tasksContent);
		if (closingError) return errorResult(`closing wave gate: ${closingError}`);
	} catch {
		/* tasks.md may not exist for all sizes */
	}

	try {
		const currentStatus = effectiveStatus(task?.status);
		const newPrimary = completeTask(projectPath, taskSlug);
		appendAudit(projectPath, { action: "spec.complete", target: taskSlug, user: "mcp" });
		appendAudit(projectPath, {
			action: "task.status_change",
			target: taskSlug,
			detail: `${currentStatus} → done (dossier:complete)`,
		});
		syncTaskStatus(projectPath, taskSlug, "done");

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
 * Check that ALL Closing Wave items are checked.
 * Returns error message listing unchecked items if any, undefined if all done.
 */
export function checkClosingWave(tasksContent: string): string | undefined {
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
			if (!params.reason || params.reason.trim() === "") {
				return errorResult(
					'reason is required for gate clear — describe what was reviewed (e.g., "3-agent review completed, 0 critical issues")',
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

		case "status": {
			const gate = readReviewGate(projectPath);
			if (!gate) return jsonResult({ gate: null });
			return jsonResult(gate);
		}

		default:
			return errorResult(`unknown gate sub_action: ${subAction} (valid: set/clear/status)`);
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
			if (inClosing && line.match(/^- \[[ x]\] /)) {
				closingIndex++;
				if (closingIndex === nth) {
					if (line.startsWith("- [x] ")) {
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
		// Standard T-N.N format: match by text inclusion.
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
				(l) => l.match(/^- \[x\] /) && l.toLowerCase().includes(taskIdLower),
			);
			if (alreadyChecked) {
				return jsonResult({ task_id: taskId, status: "already_checked" });
			}
			return errorResult(`task_id "${taskId}" not found in tasks.md`);
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
