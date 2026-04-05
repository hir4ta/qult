import { loadConfig } from "../config.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import { getActivePlan } from "../state/plan-status.ts";
import {
	isGateDisabled,
	isReviewRequired,
	readEscalation,
	readLastReview,
	readSessionState,
	readTaskVerifyResult,
} from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { block } from "./respond.ts";

// Escalation thresholds: advisory warnings become blocking after N occurrences
const SECURITY_ESCALATION_THRESHOLD = 10;

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
const DRIFT_ESCALATION_THRESHOLD = 8;
const TEST_QUALITY_ESCALATION_THRESHOLD = 8;

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

	// Skip plan-required and review gates when no source files changed (post-commit or release state)
	if (hasSourceChanges) {
		// Block if large change without a plan (enforces "architect designs, agent implements")
		if (!plan) {
			const changed = state.changed_file_paths.length;
			const threshold = loadConfig().review.required_changed_files;
			if (changed >= threshold) {
				block(
					`${changed} files changed without a plan. Run /qult:plan-generator before continuing.\n` +
						"Large changes require a structured plan so TDD enforcement, task verification, and scope tracking can function.",
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

	// Guide: suggest /qult:finish when review is complete (advisory, not blocking)
	if (readLastReview()) {
		process.stderr.write(
			"[qult] Review complete. Run /qult:finish for structured branch completion (merge/PR/hold/discard).\n",
		);
	}

	// Escalation: block if excessive quality warnings accumulated (advisory → enforcement)
	const securityCount = readEscalation("security_warning_count");
	if (securityCount >= SECURITY_ESCALATION_THRESHOLD && !isGateDisabled("security-check")) {
		block(
			`${securityCount} security warnings emitted this session. Fix security issues before finishing.`,
		);
	}

	const driftCount = readEscalation("drift_warning_count");
	if (driftCount >= DRIFT_ESCALATION_THRESHOLD) {
		block(
			`${driftCount} drift warnings emitted this session. Review scope and address drift before finishing.`,
		);
	}

	const testQualityCount = readEscalation("test_quality_warning_count");
	if (testQualityCount >= TEST_QUALITY_ESCALATION_THRESHOLD) {
		block(
			`${testQualityCount} test quality warnings emitted this session. Improve test assertions before finishing.`,
		);
	}
}
