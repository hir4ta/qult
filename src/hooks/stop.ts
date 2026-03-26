import { readPace } from "../state/pace.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import { getActivePlan } from "../state/plan-status.ts";
import type { HookEvent } from "../types.ts";
import { block, respond } from "./respond.ts";

const PACE_YELLOW_MINUTES = 20;

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
		if (incomplete.length > 0) {
			const taskList = incomplete.map((t) => `  [${t.status}] ${t.name}`).join("\n");
			block(
				`Plan has ${incomplete.length} incomplete item(s). Complete or update status before finishing:\n${taskList}\nPlan: ${plan.path}`,
			);
		}
	}

	// Pace warning (soft)
	const pace = readPace();
	if (pace) {
		const commitTime = new Date(pace.last_commit_at).getTime();
		if (Number.isNaN(commitTime)) return;
		const elapsed = (Date.now() - commitTime) / 60_000;
		if (elapsed >= PACE_YELLOW_MINUTES) {
			respond(
				`${Math.round(elapsed)} minutes since last commit. Consider committing your current progress.`,
			);
		}
	}
}
