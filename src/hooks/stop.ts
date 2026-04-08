import { loadConfig } from "../config.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import { getActivePlan } from "../state/plan-status.ts";
import {
	getReviewIteration,
	isGateDisabled,
	isReviewRequired,
	readEscalation,
	readHumanApproval,
	readLastReview,
	readSessionState,
	readTaskVerifyResult,
} from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { block } from "./respond.ts";

/** Source code extensions — non-source changes (version bumps, build artifacts) skip gates. */
const SOURCE_EXTS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
	".mjs",
	".cjs",
	".py",
	".pyi",
	".go",
	".rs",
	".rb",
	".java",
	".kt",
	".php",
	".cs",
	".vue",
	".svelte",
]);

/** Stop: block if pending-fixes, incomplete plan, or no review */
export default async function stop(ev: HookEvent): Promise<void> {
	if (ev.stop_hook_active) return;

	// Block if pending lint/type fixes
	const fixes = readPendingFixes();
	if (fixes.length > 0) {
		const fileList = fixes.map((f) => `  ${f.file}`).join("\n");
		block(`Pending lint/type errors remain. Fix these before completing:\n${fileList}`);
	}

	const state = readSessionState();
	const changedPaths = state.changed_file_paths ?? [];
	const hasChanges = changedPaths.length > 0;

	// Skip plan/review gates when only non-source files changed (e.g. release: version bump + build artifacts)
	const hasSourceChanges =
		hasChanges &&
		changedPaths.some((p) => {
			const ext = p.slice(p.lastIndexOf("."));
			return SOURCE_EXTS.has(ext);
		});

	// Plan checks: incomplete tasks, then Verify results (block() throws, so sequential)
	const plan = getActivePlan();
	if (plan && hasSourceChanges) {
		const incomplete = plan.tasks.filter((t) => t.status !== "done");
		if (incomplete.length > 0) {
			const taskList = incomplete.map((t) => `  [${t.status}] ${t.name}`).join("\n");
			block(
				`Plan has ${incomplete.length} incomplete item(s). Complete or update status before finishing:\n${taskList}\nPlan: ${plan.path}`,
			);
		}

		// Check plan tasks with Verify field for recorded test results.
		// Only block tasks that were tracked via TaskCreate (have an entry in task_verify_results).
		// Tasks not tracked via TaskCreate get an advisory warning instead of blocking,
		// since Verify enforcement requires the TaskCreate → TaskCompleted → Verify pipeline.
		const doneTasks = plan.tasks.filter((t) => t.status === "done" && t.verify?.includes(":"));
		const tracked: typeof doneTasks = [];
		const untracked: typeof doneTasks = [];
		const failed: { task: (typeof doneTasks)[number]; key: string }[] = [];
		for (const t of doneTasks) {
			const key = t.taskNumber != null ? `Task ${t.taskNumber}` : t.name;
			const result = readTaskVerifyResult(key);
			if (result !== null) {
				tracked.push(t);
				// Block if Verify test was tracked but did NOT pass
				if (result.passed !== true) {
					failed.push({ task: t, key });
				}
			} else {
				untracked.push(t);
			}
		}
		if (failed.length > 0) {
			const list = failed.map((f) => `  ${f.key}: ${f.task.name}`).join("\n");
			block(
				`${failed.length} plan task(s) have failing Verify tests:\n${list}\nFix tests before finishing.`,
			);
		}
		// Advisory: suggest TaskCreate for untracked tasks (non-blocking)
		if (untracked.length > 0) {
			const list = untracked.map((t) => `  Task ${t.taskNumber ?? "?"}: ${t.name}`).join("\n");
			process.stderr.write(
				`[qult] ${untracked.length} plan task(s) have Verify fields but were not tracked via TaskCreate:\n${list}\nConsider using TaskCreate for Verify test execution.\n`,
			);
		}
	}

	// Skip plan-required and review gates when no source files changed (post-commit or release state)
	if (hasSourceChanges) {
		// Block if large change without a plan (enforces "architect designs, agent implements")
		if (!plan) {
			const changed = state.changed_file_paths.length;
			const threshold = loadConfig().review.required_changed_files;
			if (changed >= threshold) {
				process.stderr.write(
					`[qult] Advisory: ${changed} files changed without a plan. Consider using /qult:explore for complex changes.\n`,
				);
			}
		}

		// Block if no review has been run (conditional on change size / plan)
		if (!readLastReview()) {
			if (isReviewRequired() && !isGateDisabled("review") && getReviewIteration() === 0) {
				block("Run /qult:review before finishing. Independent review is required.");
			}
		}
	}

	// Block if human approval required but not recorded
	const lastReview = readLastReview();
	if (hasSourceChanges && lastReview) {
		const config = loadConfig();
		if (config.review.require_human_approval && !readHumanApproval()) {
			block(
				"Human approval required. The architect must review the changes and call record_human_approval before finishing.",
			);
		}
	}

	// Guide: suggest /qult:finish when review is complete (advisory, not blocking)
	if (lastReview) {
		process.stderr.write(
			"[qult] Review complete. Run /qult:finish for structured branch completion (merge/PR/hold/discard).\n",
		);
	}

	// Escalation: block if excessive quality warnings accumulated (advisory → enforcement)
	const escalation = loadConfig().escalation;

	const securityCount = readEscalation("security_warning_count");
	if (securityCount >= escalation.security_threshold && !isGateDisabled("security-check")) {
		block(
			`${securityCount} security warnings emitted this session. Fix security issues before finishing.`,
		);
	}

	const driftCount = readEscalation("drift_warning_count");
	if (driftCount >= escalation.drift_threshold) {
		block(
			`${driftCount} drift warnings emitted this session. Review scope and address drift before finishing.`,
		);
	}

	const testQualityCount = readEscalation("test_quality_warning_count");
	if (testQualityCount >= escalation.test_quality_threshold) {
		block(
			`${testQualityCount} test quality warnings emitted this session. Improve test assertions before finishing.`,
		);
	}

	const duplicationCount = readEscalation("duplication_warning_count");
	if (duplicationCount >= escalation.duplication_threshold) {
		block(
			`${duplicationCount} duplication warnings emitted this session. Extract shared code before finishing.`,
		);
	}
}
