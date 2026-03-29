import { resolve } from "node:path";
import { loadGates } from "../gates/load.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import {
	isReviewRequired,
	readLastReview,
	readLastTestPass,
	recordPlanSelfcheckBlocked,
	wasPlanSelfcheckBlocked,
} from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { deny } from "./respond.ts";

const GIT_COMMIT_RE = /\bgit\s+commit\b/;

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

	const fixes = readPendingFixes();
	if (fixes.length > 0) {
		const resolvedTarget = resolve(targetFile);
		const isFixingPendingFile = fixes.some((f) => resolve(f.file) === resolvedTarget);

		if (!isFixingPendingFile) {
			const fileList = fixes
				.map((f) => `  ${f.file}: ${f.errors[0]?.slice(0, 100) ?? "error"}`)
				.join("\n");
			deny(`Fix existing errors before editing other files:\n${fileList}`);
		}
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
		if (!readLastTestPass()) {
			deny("Run tests before committing. No test pass recorded since last commit.");
		}
	}

	// Require independent review before commit (conditional on change size / plan)
	if (!readLastReview()) {
		if (isReviewRequired()) {
			deny("Run /qult:review before committing. Independent review is required.");
		}
	}
}
