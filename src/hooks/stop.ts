import { readFileSync } from "node:fs";
import { readPendingFixes } from "../state/pending-fixes.ts";
import { getActivePlan } from "../state/plan-status.ts";
import { readLastReview, readPace } from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { block } from "./respond.ts";

const PACE_YELLOW_MINUTES = 20;
const TASK_HEADER_RE = /^###\s+Task\s+\d+:/m;

/** Count only ### Task N: headers in plan content (excludes Review Gate checkboxes) */
function countTaskHeaders(planPath: string): number {
	try {
		const content = readFileSync(planPath, "utf-8");
		return (content.match(new RegExp(TASK_HEADER_RE.source, "gm")) ?? []).length;
	} catch {
		return 0;
	}
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

	// Block if plan has incomplete tasks
	const plan = getActivePlan();
	if (plan) {
		const incomplete = plan.tasks.filter((t) => t.status !== "done");
		const taskCount = countTaskHeaders(plan.path);
		if (incomplete.length > 0) {
			if (taskCount > 3) {
				// Large plan: block
				const taskList = incomplete.map((t) => `  [${t.status}] ${t.name}`).join("\n");
				block(
					`Plan has ${incomplete.length} incomplete item(s). Complete or update status before finishing:\n${taskList}\nPlan: ${plan.path}`,
				);
			} else {
				// Small plan: warn only
				process.stderr.write(
					`[alfred] Plan has ${incomplete.length} incomplete item(s). Consider updating before finishing.\n`,
				);
			}
		}
	}

	// Block if no review has been run (always required, with or without plan)
	if (!readLastReview()) {
		block("Run /alfred:review before finishing. Independent review is required.");
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
