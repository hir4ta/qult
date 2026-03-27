import { getLatestPlanContent } from "../state/plan-status.ts";
import { recordReview } from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { block } from "./respond.ts";

// [severity] file:line pattern or "No issues found"
const FINDING_RE = /\[(critical|high|medium|low)\]/i;
const NO_ISSUES_RE = /no issues found/i;
const REVIEW_PASS_RE = /^Review:\s*PASS/im;
const REVIEW_FAIL_RE = /^Review:\s*FAIL/im;

/** SubagentStop: verify subagent output quality */
export default async function subagentStop(ev: HookEvent): Promise<void> {
	if (ev.stop_hook_active) return;

	const agentType = ev.agent_type;
	const output = ev.last_assistant_message;

	// fail-open: no agent_type or no output → allow
	if (!agentType || !output) return;

	if (agentType === "alfred-reviewer") {
		validateReviewer(output);
		// If we get here (no block), review passed — record it
		recordReview();
	} else if (agentType === "Plan") {
		validatePlan();
	}
	// Unknown agent_type → allow (fail-open)
}

function validateReviewer(output: string): void {
	// Accept structured output: Review: PASS/FAIL, findings, or "No issues found"
	const hasVerdict = REVIEW_PASS_RE.test(output) || REVIEW_FAIL_RE.test(output);
	const hasFindings = FINDING_RE.test(output) || NO_ISSUES_RE.test(output);
	if (hasVerdict || hasFindings) return;
	block(
		"Reviewer output must start with 'Review: PASS' or 'Review: FAIL', contain findings ([severity] file:line), or 'No issues found'. Rerun the review with structured output.",
	);
}

function validatePlan(): void {
	const content = getLatestPlanContent();
	if (!content) return; // fail-open: no plan file found

	const hasTasks = content.includes("## Tasks");
	const hasReview = /review/i.test(content) && /gates?/i.test(content);
	if (hasTasks && hasReview) return;

	const missing: string[] = [];
	if (!hasTasks) missing.push("## Tasks");
	if (!hasReview) missing.push("Review Gates");
	block(`Plan is missing required sections: ${missing.join(", ")}. Add them before exiting.`);
}
