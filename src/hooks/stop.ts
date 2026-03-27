import { readFileSync } from "node:fs";
import { recordAction } from "../state/metrics.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import {
	getActivePlan,
	parseCriteriaCommands,
	parseFileFields,
	parseVerifyFields,
	TASK_RE,
} from "../state/plan-status.ts";
import {
	isReviewRequired,
	readLastReview,
	readPace,
	readSessionState,
} from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { block } from "./respond.ts";

const PACE_YELLOW_MINUTES = 20;

/** Count only ### Task N: headers in plan content (excludes Review Gate checkboxes) */
function countTaskHeaders(content: string): number {
	return (content.match(new RegExp(TASK_RE.source, "gm")) ?? []).length;
}

/** Stop: block if pending-fixes or incomplete plan, warn on pace */
export default async function stop(ev: HookEvent): Promise<void> {
	if (ev.stop_hook_active) return;

	// Block if pending lint/type fixes
	const fixes = readPendingFixes();
	if (fixes.length > 0) {
		const fileList = fixes.map((f) => `  ${f.file}`).join("\n");
		block(`Pending lint/type errors remain. Fix these before completing:\n${fileList}`);
	}

	// Block if plan has incomplete tasks / unverified fields / unexecuted criteria
	const plan = getActivePlan();
	if (plan) {
		const content = readFileSync(plan.path, "utf-8");
		const taskCount = countTaskHeaders(content);
		const isLarge = taskCount > 3;

		// Check: incomplete tasks
		const incomplete = plan.tasks.filter((t) => t.status !== "done");
		if (incomplete.length > 0) {
			if (isLarge) {
				const taskList = incomplete.map((t) => `  [${t.status}] ${t.name}`).join("\n");
				block(
					`Plan has ${incomplete.length} incomplete item(s). Complete or update status before finishing:\n${taskList}\nPlan: ${plan.path}`,
				);
			} else {
				process.stderr.write(
					`[alfred] Plan has ${incomplete.length} incomplete item(s). Consider updating before finishing.\n`,
				);
			}
		}

		const state = readSessionState();

		// Check A: verify field completion
		try {
			const verifies = parseVerifyFields(content);
			const verified = state.verified_fields ?? [];
			const unverified = verifies
				.filter((v) => v.testFunction)
				.filter((v) => !verified.includes(`${v.taskName}:${v.testFunction}`));

			if (unverified.length > 0) {
				const list = unverified.map((v) => `  ${v.taskName}: ${v.testFunction}`).join("\n");
				if (isLarge) {
					block(
						`${unverified.length} verify field(s) not yet executed. Run the tests before finishing:\n${list}`,
					);
				} else {
					process.stderr.write(
						`[alfred] ${unverified.length} verify field(s) not yet executed:\n${list}\n`,
					);
				}
			}
		} catch {
			// fail-open
		}

		// Check B: file divergence (advisory only)
		try {
			const plannedFiles = parseFileFields(content);
			const changedPaths = state.changed_file_paths ?? [];

			if (plannedFiles.length > 0 && changedPaths.length > 0) {
				// Compare using path endings to handle absolute vs relative paths
				const plannedSuffixes = plannedFiles.map((f) => f.filePath);
				const unplannedFiles = changedPaths.filter(
					(p) => !plannedSuffixes.some((s) => p.endsWith(s)),
				);

				if (unplannedFiles.length > plannedFiles.length) {
					const list = unplannedFiles
						.slice(0, 10)
						.map((f) => `  ${f}`)
						.join("\n");
					process.stderr.write(
						`[alfred] ${unplannedFiles.length} file(s) changed outside the plan (possible scope creep):\n${list}\n`,
					);
				}
			}
		} catch {
			// fail-open
		}

		// Check C: criteria command execution
		try {
			const criteriaCommands = parseCriteriaCommands(content);
			const executed = state.criteria_commands_run ?? [];
			const unexecuted = criteriaCommands.filter(
				(cmd) => !executed.some((e) => e.includes(cmd) || cmd.includes(e)),
			);

			if (unexecuted.length > 0) {
				const list = unexecuted.map((c) => `  \`${c}\``).join("\n");
				if (isLarge) {
					block(
						`${unexecuted.length} Success Criteria command(s) not yet executed:\n${list}\nRun these commands before finishing.`,
					);
				} else {
					process.stderr.write(
						`[alfred] ${unexecuted.length} Success Criteria command(s) not yet executed:\n${list}\n`,
					);
				}
			}
		} catch {
			// fail-open
		}
	}

	// Block if no review has been run (conditional on change size / plan)
	if (!readLastReview()) {
		if (isReviewRequired()) {
			block("Run /alfred:review before finishing. Independent review is required.");
		} else {
			try {
				recordAction("stop", "review-skipped", "Small change — review not required");
			} catch {
				/* fail-open */
			}
			process.stderr.write(
				"[alfred] Review not required for this change size, but consider running /alfred:review for important changes.\n",
			);
		}
	}

	// Pace warning (soft) — Stop hook does not support additionalContext,
	// so we use stderr for advisory messages (non-blocking)
	const pace = readPace();
	if (pace) {
		const commitTime = new Date(pace.last_commit_at).getTime();
		if (Number.isNaN(commitTime)) return;
		const elapsed = (Date.now() - commitTime) / 60_000;
		if (elapsed >= PACE_YELLOW_MINUTES) {
			process.stderr.write(
				`[alfred] ${Math.round(elapsed)} minutes since last commit. Consider committing your current progress.\n`,
			);
		}
	}
}
