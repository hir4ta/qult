import { readPendingFixes } from "../state/pending-fixes.ts";
import { getActivePlan } from "../state/plan-status.ts";
import {
	isGateDisabled,
	isReviewRequired,
	readLastReview,
	readTaskVerifyResult,
} from "../state/session-state.ts";
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

	// Plan checks: incomplete tasks, then Verify results (block() throws, so sequential)
	const plan = getActivePlan();
	if (plan) {
		const incomplete = plan.tasks.filter((t) => t.status !== "done");
		if (incomplete.length > 0) {
			const taskList = incomplete.map((t) => `  [${t.status}] ${t.name}`).join("\n");
			block(
				`Plan has ${incomplete.length} incomplete item(s). Complete or update status before finishing:\n${taskList}\nPlan: ${plan.path}`,
			);
		}

		// Block if plan tasks with Verify field have no recorded test result
		// (indirect enforcement: TaskCreate → TaskCompleted → Verify execution → result recorded)
		const doneTasks = plan.tasks.filter((t) => t.status === "done" && t.verify?.includes(":"));
		const unverified = doneTasks.filter((t) => {
			const key = t.taskNumber != null ? `Task ${t.taskNumber}` : t.name;
			return readTaskVerifyResult(key) === null;
		});
		if (unverified.length > 0) {
			const list = unverified.map((t) => `  Task ${t.taskNumber ?? "?"}: ${t.name}`).join("\n");
			block(
				`${unverified.length} plan task(s) have Verify fields but no test result recorded:\n${list}\nUse TaskCreate to track tasks so TaskCompleted triggers Verify test execution.`,
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
