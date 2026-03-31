import { readPendingFixes } from "../state/pending-fixes.ts";
import { getActivePlan } from "../state/plan-status.ts";
import { isGateDisabled, isReviewRequired, readLastReview } from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { block } from "./respond.ts";

/** Stop: block if pending-fixes, incomplete plan, or no review */
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

	// Block if no review has been run (conditional on change size / plan)
	if (!readLastReview()) {
		if (isReviewRequired() && !isGateDisabled("review")) {
			block("Run /qult:review before finishing. Independent review is required.");
		}
	}
}
