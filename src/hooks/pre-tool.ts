import { resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { loadGates } from "../gates/load.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import { getActivePlan, hasPlanFile, parseVerifyField } from "../state/plan-status.ts";
import {
	isGateDisabled,
	isReviewRequired,
	readHumanApproval,
	readLastReview,
	readLastTestPass,
	readSessionState,
	readTaskVerifyResult,
	recordPlanSelfcheckBlocked,
	wasPlanSelfcheckBlocked,
} from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { deny } from "./respond.ts";
import { sanitizeForStderr } from "./sanitize.ts";

const GIT_COMMIT_RE = /\bgit\s+(?:-\S+(?:\s+\S+)?\s+)*commit\b/i;
const driftWarnedFiles = new Set<string>();

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

	// TaskCreate promotion: remind to use TaskCreate when editing plan task files
	try {
		suggestTaskCreate(resolvedTarget);
	} catch {
		/* fail-open */
	}

	// Task drift detection: warn when editing files outside plan scope
	try {
		checkTaskDrift(resolvedTarget);
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("process.exit")) throw e;
		/* fail-open */
	}
}

/** Suggest TaskCreate when editing a file that matches a plan task for the first time. */
function suggestTaskCreate(resolvedTarget: string): void {
	const plan = getActivePlan();
	if (!plan) return;

	const cwd = process.cwd();
	const changed = readSessionState().changed_file_paths ?? [];

	// Only suggest on first edit of a file (not already in changed_file_paths)
	if (changed.includes(resolvedTarget)) return;

	for (const task of plan.tasks) {
		if (!task.file) continue;
		const taskFile = resolve(cwd, task.file);
		if (resolvedTarget === taskFile) {
			process.stderr.write(
				`[qult] Plan task detected for ${task.file}. Use TaskCreate to track progress and enable Verify test execution.\n`,
			);
			return;
		}
	}
}

/** Task drift: warn (not deny) when editing files outside the plan scope. */
function checkTaskDrift(resolvedTarget: string): void {
	const plan = getActivePlan();
	if (!plan) return;
	if (driftWarnedFiles.has(resolvedTarget)) return;

	const cwd = process.cwd();
	const planFiles = new Set(plan.tasks.filter((t) => t.file).map((t) => resolve(cwd, t.file!)));

	if (planFiles.has(resolvedTarget)) return;

	const relative = resolvedTarget.startsWith(cwd)
		? resolvedTarget.slice(cwd.length + 1)
		: resolvedTarget;
	process.stderr.write(
		`[qult] Task drift: ${sanitizeForStderr(relative)} is not in the current plan scope.\n`,
	);
	driftWarnedFiles.add(resolvedTarget);
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

		// RED verification: if Verify test was run and passed BEFORE implementation, it's a no-op test
		const taskKey = task.taskNumber != null ? `Task ${task.taskNumber}` : task.name;
		const verifyResult = readTaskVerifyResult(taskKey);
		if (verifyResult?.passed === true) {
			deny(
				`TDD: test for ${taskKey} already passes before implementation. Write a failing test first (RED), then implement (GREEN).`,
			);
		}

		return;
	}
}

/** File extensions considered "source code" for gate purposes.
 *  Non-source changes (package.json, README, dist/) skip test/review gates. */
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

function hasSourceChanges(paths: string[]): boolean {
	return paths.some((p) => {
		const ext = p.slice(p.lastIndexOf("."));
		return SOURCE_EXTS.has(ext);
	});
}

function checkBash(ev: HookEvent): void {
	const command = typeof ev.tool_input?.command === "string" ? ev.tool_input.command : null;
	if (!command) return;
	if (!GIT_COMMIT_RE.test(command)) return;

	const state = readSessionState();
	const changedPaths = state.changed_file_paths ?? [];
	const changedCount = changedPaths.length;

	// Skip all commit gates when no source code changed (e.g. release commits: version bump + build artifacts)
	if (!hasSourceChanges(changedPaths)) return;

	// Require tests to pass before commit (only if project has test gates)
	const gates = loadGates();
	if (gates?.on_commit && Object.keys(gates.on_commit).length > 0) {
		const allCommitGatesDisabled = Object.keys(gates.on_commit).every((g) => isGateDisabled(g));
		if (!allCommitGatesDisabled && !readLastTestPass()) {
			deny("Run tests before committing. No test pass recorded since last commit.");
		}
	}

	if (changedCount > 0) {
		// Require plan when many files changed (structural enforcement — not bypassable)
		if (changedCount >= loadConfig().review.required_changed_files && !hasPlanFile()) {
			deny(
				`${changedCount} files changed without a plan. Run /qult:plan-generator before committing.`,
			);
		}

		// Require independent review before commit (independent of gates config)
		if (!readLastReview()) {
			if (isReviewRequired() && !isGateDisabled("review")) {
				deny("Run /qult:review before committing. Independent review is required.");
			}
		}

		// Require human approval when configured
		if (readLastReview() && loadConfig().review.require_human_approval && !readHumanApproval()) {
			deny(
				"Human approval required before committing. The architect must review and call record_human_approval.",
			);
		}
	}
}
