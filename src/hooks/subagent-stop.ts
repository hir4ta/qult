import {
	getReviewIteration,
	recordReview,
	recordReviewIteration,
	resetReviewIteration,
} from "../state/session-state.ts";
import type { HookEvent } from "../types.ts";
import { block } from "./respond.ts";

// [severity] file:line pattern or "No issues found"
const SEVERITY_PATTERN = /\[(critical|high|medium|low)\]/;
const FINDING_RE = new RegExp(SEVERITY_PATTERN.source, "i");
const NO_ISSUES_RE = /no issues found/i;
const REVIEW_PASS_RE = /^Review:\s*PASS/im;
const REVIEW_FAIL_RE = /^Review:\s*FAIL/im;
// Score parsing: strict → colon → loose fallback
const SCORE_STRICT_RE = /Score:\s*Correctness=(\d)\s+Design=(\d)\s+Security=(\d)/i;
const SCORE_COLON_RE = /Correctness[=:]\s*(\d).*?Design[=:]\s*(\d).*?Security[=:]\s*(\d)/i;
const SCORE_LOOSE_RE = /Score:.*?[=:]\s*(\d).*?[=:]\s*(\d).*?[=:]\s*(\d)/i;

export interface ReviewScores {
	correctness: number;
	design: number;
	security: number;
}

/** Parse reviewer scores with graduated fallback (strict → colon → loose). */
export function parseScores(output: string): ReviewScores | null {
	for (const re of [SCORE_STRICT_RE, SCORE_COLON_RE, SCORE_LOOSE_RE]) {
		const m = re.exec(output);
		if (m) {
			return {
				correctness: Number.parseInt(m[1]!, 10),
				design: Number.parseInt(m[2]!, 10),
				security: Number.parseInt(m[3]!, 10),
			};
		}
	}
	return null;
}

const DEFAULT_REVIEW_SCORE_THRESHOLD = 12;
const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

/** SubagentStop: verify subagent output quality */
export default async function subagentStop(ev: HookEvent): Promise<void> {
	if (ev.stop_hook_active) return;

	const agentType = ev.agent_type;
	const output = ev.last_assistant_message;

	// fail-open: no agent_type or no output → allow
	if (!agentType || !output) return;

	if (agentType === "qult-reviewer") {
		validateReviewer(output);

		const passed = REVIEW_PASS_RE.test(output);
		const failed = REVIEW_FAIL_RE.test(output);

		if (failed) {
			block("Review: FAIL. Fix the issues found by the reviewer and run /qult:review again.");
		}

		// Score threshold enforcement: PASS with low aggregate → block for iteration
		const scores = parseScores(output);
		if (passed && scores) {
			const aggregate = scores.correctness + scores.design + scores.security;
			const threshold = DEFAULT_REVIEW_SCORE_THRESHOLD;
			const maxIter = DEFAULT_MAX_REVIEW_ITERATIONS;

			try {
				recordReviewIteration(aggregate);
			} catch {
				/* fail-open */
			}

			const iterCount = getReviewIteration();

			if (aggregate < threshold && iterCount < maxIter) {
				block(
					`Review: PASS but aggregate score ${aggregate}/15 is below threshold ${threshold}/15. ` +
						`Iteration ${iterCount}/${maxIter}. Fix weak areas and run /qult:review again.`,
				);
			}
		}
		resetReviewIteration();
		recordReview();
	} else if (agentType === "Plan") {
		validatePlan();
	}
	// Unknown agent_type → allow (fail-open)
}

function validatePlan(): void {
	try {
		const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
		const { join } = require("node:path");
		const planDir = join(process.cwd(), ".claude", "plans");
		if (!existsSync(planDir)) return;

		const files = (readdirSync(planDir) as string[])
			.filter((f: string) => f.endsWith(".md"))
			.map((f: string) => ({
				name: f,
				mtime: statSync(join(planDir, f)).mtimeMs,
			}))
			.sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);

		if (files.length === 0) return;
		const content = readFileSync(join(planDir, files[0]!.name), "utf-8") as string;
		if (!content.includes("## Tasks")) {
			block("Plan is missing required section: ## Tasks. Add it before exiting.");
		}
	} catch {
		// fail-open
	}
}

function validateReviewer(output: string): void {
	const hasVerdict = REVIEW_PASS_RE.test(output) || REVIEW_FAIL_RE.test(output);
	const hasFindings = FINDING_RE.test(output) || NO_ISSUES_RE.test(output);
	const hasScore = parseScores(output) !== null;

	// Accept if: findings present (backward compat) OR verdict + score
	if (hasFindings) return;
	if (hasVerdict && hasScore) return;

	block(
		"Reviewer output must include: (1) 'Review: PASS' or 'Review: FAIL', (2) 'Score: Correctness=N Design=N Security=N', and (3) findings ([severity] file:line) or 'No issues found'. Rerun the review.",
	);
}
