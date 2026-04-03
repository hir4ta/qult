import { resolve } from "node:path";
import { loadGates } from "../gates/load.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import { getActivePlan, parseVerifyField } from "../state/plan-status.ts";
import {
	isGateDisabled,
	isReviewRequired,
	readLastReview,
	readLastTestPass,
	readSessionState,
	recordPlanSelfcheckBlocked,
	wasPlanSelfcheckBlocked,
} from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { deny } from "./respond.ts";

const GIT_COMMIT_RE = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*commit\b/i;

/** PreToolUse: DENY pending-fixes edits, commit without tests/review, plan selfcheck */
export default async function preTool(ev: HookEvent): Promise<void> {
	const tool = ev.tool_name;

	if (tool === "ExitPlanMode") {
		checkExitPlanMode();
	} else if (tool === "Edit" || tool === "Write") {
		checkEditWrite(ev);
	} else if (tool === "Bash") {
		checkBash(ev);
	}
}

/** 1-time gate: block ExitPlanMode once to force a selfcheck.
 *  Claude reviews the session for omissions, then calls ExitPlanMode again. */
function checkExitPlanMode(): void {
	if (wasPlanSelfcheckBlocked()) return; // already blocked once — pass through
	recordPlanSelfcheckBlocked();
	deny(
		"Before finalizing the plan, review the entire session from start to now for omissions. " +
			"Check: missing files, untested edge cases, migration concerns, documentation gaps, " +
			"dependency changes, and anything discussed but not included in the plan. " +
			"After your review, call ExitPlanMode again.",
	);
}

function checkEditWrite(ev: HookEvent): void {
	const targetFile = typeof ev.tool_input?.file_path === "string" ? ev.tool_input.file_path : null;
	if (!targetFile) return;
	const resolvedTarget = resolve(targetFile);

	const fixes = readPendingFixes();
	if (fixes.length > 0) {
		const isFixingPendingFile = fixes.some((f) => resolve(f.file) === resolvedTarget);

		if (!isFixingPendingFile) {
			const fileList = fixes
				.map((f) => {
					const totalErrors = f.errors.length;
					const shown = f.errors.slice(0, 3).map((e) => `    ${e.slice(0, 200)}`);
					const suffix = totalErrors > 3 ? `\n    ... and ${totalErrors - 3} more error(s)` : "";
					return `  ${f.file} (${totalErrors} error(s)):\n${shown.join("\n")}${suffix}`;
				})
				.join("\n");
			deny(`Fix existing errors before editing other files:\n${fileList}`);
		}
	}

	// TDD enforcement: test file must be edited before implementation file
	try {
		checkTddOrder(resolvedTarget);
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("process.exit")) throw e;
		// fail-open
	}
}

/** TDD: deny editing an implementation file if its corresponding test file hasn't been edited yet. */
function checkTddOrder(resolvedTarget: string): void {
	const plan = getActivePlan();
	if (!plan) return;

	const cwd = process.cwd();
	const changed = readSessionState().changed_file_paths ?? [];

	for (const task of plan.tasks) {
		if (!task.file || !task.verify) continue;

		const parsed = parseVerifyField(task.verify);
		if (!parsed) continue;

		const implFile = resolve(cwd, task.file);
		if (resolvedTarget !== implFile) continue;

		const testFile = resolve(cwd, parsed.file);

		// Editing the test file itself is always allowed
		if (resolvedTarget === testFile) return;

		if (!changed.includes(testFile)) {
			deny(`TDD: write the test first. Edit ${parsed.file} before ${task.file}.`);
		}

		return;
	}
}

function checkBash(ev: HookEvent): void {
	const command = typeof ev.tool_input?.command === "string" ? ev.tool_input.command : null;
	if (!command) return;
	if (!GIT_COMMIT_RE.test(command)) return;

	// Only enforce commit gates if project has gates configured
	const gates = loadGates();
	if (!gates) return;

	// Require tests to pass before commit (only if project has test gates)
	if (gates.on_commit && Object.keys(gates.on_commit).length > 0) {
		const allCommitGatesDisabled = Object.keys(gates.on_commit).every((g) => isGateDisabled(g));
		if (!allCommitGatesDisabled && !readLastTestPass()) {
			deny("Run tests before committing. No test pass recorded since last commit.");
		}
	}

	// Require independent review before commit (conditional on change size / plan)
	if (!readLastReview()) {
		if (isReviewRequired() && !isGateDisabled("review")) {
			deny("Run /qult:review before committing. Independent review is required.");
		}
	}
}
