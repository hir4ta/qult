import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../config.ts";
import {
	getPlanEvalIteration,
	getPlanEvalScoreHistory,
	getReviewIteration,
	getReviewScoreHistory,
	recordPlanEvalIteration,
	recordReview,
	recordReviewIteration,
	resetPlanEvalIteration,
	resetReviewIteration,
} from "../../state/session-state.ts";
import type { HookEvent } from "../../types.ts";
import { block } from "../respond.ts";
import { buildPlanEvalBlockMessage, buildReviewBlockMessage } from "./message-builders.ts";
import {
	PLAN_EVAL_DIMENSIONS,
	validatePlanHeuristics,
	validatePlanStructure,
} from "./plan-validators.ts";
import { parseDimensionScores, parseScores } from "./score-parsers.ts";

// [severity] file:line pattern or "No issues found"
const SEVERITY_PATTERN = /\[(critical|high|medium|low)\]/;
const FINDING_RE = new RegExp(SEVERITY_PATTERN.source, "i");
const NO_ISSUES_RE = /no issues found/i;
const REVIEW_PASS_RE = /^Review:\s*PASS/im;
const REVIEW_FAIL_RE = /^Review:\s*FAIL/im;

// Plan evaluator verdicts
const PLAN_PASS_RE = /^Plan:\s*PASS/im;
const PLAN_REVISE_RE = /^Plan:\s*REVISE/im;

/** SubagentStop: verify subagent output quality */
export default async function subagentStop(ev: HookEvent): Promise<void> {
	if (ev.stop_hook_active) return;

	const agentType = ev.agent_type;
	const output = ev.last_assistant_message;

	// fail-open: no agent_type or no output → allow
	if (!agentType || !output) return;

	// Normalize: plugin agents use "qult:reviewer", standalone use "qult-reviewer"
	const normalized = agentType.replace(/:/g, "-");

	if (normalized === "qult-reviewer") {
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
			const config = loadConfig();
			const threshold = config.review.score_threshold;
			const maxIter = config.review.max_iterations;

			try {
				recordReviewIteration(aggregate);
			} catch {
				/* fail-open */
			}

			const iterCount = getReviewIteration();
			const history = getReviewScoreHistory();

			if (aggregate < threshold && iterCount < maxIter) {
				block(buildReviewBlockMessage(scores, history, aggregate, threshold, iterCount, maxIter));
			}
		}
		resetReviewIteration();
		recordReview();
	} else if (normalized === "qult-plan-evaluator") {
		validatePlanEvaluator(output);
	} else if (normalized === "Plan") {
		validatePlan();
	}
	// Unknown agent_type → allow (fail-open)
}

function validatePlan(): void {
	try {
		const planDir = join(process.cwd(), ".claude", "plans");
		if (!existsSync(planDir)) return;

		const files = readdirSync(planDir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => ({
				name: f,
				mtime: statSync(join(planDir, f)).mtimeMs,
			}))
			.sort((a, b) => b.mtime - a.mtime);

		if (files.length === 0) return;
		const content = readFileSync(join(planDir, files[0]!.name), "utf-8");

		// Level 1: Structural validation
		const structErrors = validatePlanStructure(content);
		if (structErrors.length > 0) {
			block(`Plan structural issues:\n${structErrors.map((e) => `  - ${e}`).join("\n")}`);
		}

		// Level 2: Heuristic validation
		const heuristicWarnings = validatePlanHeuristics(content);
		if (heuristicWarnings.length > 0) {
			block(`Plan quality issues:\n${heuristicWarnings.map((w) => `  - ${w}`).join("\n")}`);
		}
	} catch (err) {
		// fail-open — but re-throw block() exits
		if (err instanceof Error && err.message.startsWith("process.exit")) throw err;
	}
}

function validatePlanEvaluator(output: string): void {
	const hasPassed = PLAN_PASS_RE.test(output);
	const hasRevise = PLAN_REVISE_RE.test(output);
	const scores = parseDimensionScores(output, PLAN_EVAL_DIMENSIONS);

	// Validate output format — require verdict + score at minimum
	if ((!hasPassed && !hasRevise) || !scores) {
		block(
			"Plan evaluator output must include: (1) 'Plan: PASS' or 'Plan: REVISE', (2) 'Score: Feasibility=N Completeness=N Clarity=N', and (3) findings or 'No issues found'. Rerun the evaluation.",
		);
	}

	if (hasRevise) {
		block("Plan: REVISE. Fix the issues identified by the evaluator and regenerate the plan.");
	}

	// Score threshold enforcement
	if (hasPassed && scores) {
		const aggregate = Object.values(scores).reduce((sum, v) => sum + v, 0);
		const config = loadConfig();
		const threshold = config.plan_eval.score_threshold;
		const maxIter = config.plan_eval.max_iterations;

		try {
			recordPlanEvalIteration(aggregate);
		} catch {
			/* fail-open */
		}

		const iterCount = getPlanEvalIteration();
		const history = getPlanEvalScoreHistory();

		if (aggregate < threshold && iterCount < maxIter) {
			block(buildPlanEvalBlockMessage(scores, history, aggregate, threshold, iterCount, maxIter));
		}
	}

	resetPlanEvalIteration();
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
