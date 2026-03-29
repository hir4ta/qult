import { loadConfig } from "../config.ts";
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

const DEFAULT_PLAN_EVAL_SCORE_THRESHOLD = 10;
const DEFAULT_MAX_PLAN_EVAL_ITERATIONS = 2;

// --- Adaptive block message builders ---

type Trend = "improving" | "stagnant" | "regressing";

function detectTrend(history: number[]): Trend {
	if (history.length < 2) return "stagnant";
	const prev = history[history.length - 2]!;
	const curr = history[history.length - 1]!;
	if (curr > prev) return "improving";
	if (curr < prev) return "regressing";
	return "stagnant";
}

function findWeakestDimension(dimensions: Record<string, number>): {
	name: string;
	score: number;
} | null {
	let weakest: { name: string; score: number } | null = null;
	for (const [name, score] of Object.entries(dimensions)) {
		if (!weakest || score < weakest.score) {
			weakest = { name, score };
		}
	}
	return weakest;
}

/** Build trend-aware block message for review iterations. */
export function buildReviewBlockMessage(
	scores: ReviewScores,
	history: number[],
	aggregate: number,
	threshold: number,
	iterCount: number,
	maxIter: number,
): string {
	const trend = detectTrend(history);
	const weakest = findWeakestDimension({
		Correctness: scores.correctness,
		Design: scores.design,
		Security: scores.security,
	});

	const header = `Review: PASS but aggregate score ${aggregate}/15 is below threshold ${threshold}/15. Iteration ${iterCount}/${maxIter}.`;

	if (!weakest) {
		return `${header} Fix weak areas and run /qult:review again.`;
	}

	if (trend === "improving" && history.length >= 2) {
		const prev = history[history.length - 2]!;
		return `${header} Score improved ${prev}→${aggregate}. Focus on remaining weak dimension: ${weakest.name} (${weakest.score}/5).`;
	}

	if (trend === "regressing" && history.length >= 2) {
		const prev = history[history.length - 2]!;
		return `${header} Score regressed ${prev}→${aggregate}. Last changes introduced new issues — revert recent ${weakest.name.toLowerCase()}-related changes and take a minimal approach.`;
	}

	// stagnant or first iteration
	if (history.length >= 2) {
		return `${header} ${weakest.name} stuck at ${weakest.score}/5 for ${history.length} iterations. Current approach is not working — try a fundamentally different structure.`;
	}
	return `${header} Weakest dimension: ${weakest.name} (${weakest.score}/5). Fix this area first.`;
}

/** Build trend-aware block message for plan evaluation iterations. */
export function buildPlanEvalBlockMessage(
	dimensions: Record<string, number>,
	history: number[],
	aggregate: number,
	threshold: number,
	iterCount: number,
	maxIter: number,
): string {
	const trend = detectTrend(history);
	const weakest = findWeakestDimension(dimensions);

	const header = `Plan: PASS but aggregate score ${aggregate}/15 is below threshold ${threshold}/15. Iteration ${iterCount}/${maxIter}.`;

	if (!weakest) {
		return `${header} Fix weak areas and re-evaluate.`;
	}

	if (trend === "improving" && history.length >= 2) {
		const prev = history[history.length - 2]!;
		return `${header} Score improved ${prev}→${aggregate}. Focus on remaining weak dimension: ${weakest.name} (${weakest.score}/5).`;
	}

	if (trend === "regressing" && history.length >= 2) {
		const prev = history[history.length - 2]!;
		return `${header} Score regressed ${prev}→${aggregate}. Last revision made the plan worse — revert recent changes to ${weakest.name.toLowerCase()} and try a different approach.`;
	}

	if (history.length >= 2) {
		return `${header} ${weakest.name} stuck at ${weakest.score}/5 for ${history.length} iterations. Current approach is not working — restructure the plan differently.`;
	}
	return `${header} Weakest dimension: ${weakest.name} (${weakest.score}/5). Fix this area first.`;
}

// Plan evaluator verdicts
const PLAN_PASS_RE = /^Plan:\s*PASS/im;
const PLAN_REVISE_RE = /^Plan:\s*REVISE/im;

/** Generic dimension score parser. Builds regex from dimension names with graduated fallback. */
export function parseDimensionScores(
	output: string,
	dimensions: string[],
): Record<string, number> | null {
	// Strict: Score: Dim1=N Dim2=N Dim3=N
	const strictPattern = dimensions.map((d) => `${d}=(\\d)`).join("\\s+");
	const strictRe = new RegExp(`Score:\\s*${strictPattern}`, "i");

	// Colon: Dim1: N ... Dim2: N
	const colonParts = dimensions.map((d) => `${d}[=:]\\s*(\\d)`).join(".*?");
	const colonRe = new RegExp(colonParts, "i");

	for (const re of [strictRe, colonRe]) {
		const m = re.exec(output);
		if (m) {
			const result: Record<string, number> = {};
			for (let i = 0; i < dimensions.length; i++) {
				result[dimensions[i]!] = Number.parseInt(m[i + 1]!, 10);
			}
			return result;
		}
	}
	return null;
}

// --- Level 1: Structural validation ---

const TASK_HEADER_G = /^### Task \d+:/gm;
const FIELD_RES: Record<string, RegExp> = {
	File: /^\s*-\s*\*\*File\*\*/m,
	Change: /^\s*-\s*\*\*Change\*\*/m,
	Boundary: /^\s*-\s*\*\*Boundary\*\*/m,
	Verify: /^\s*-\s*\*\*Verify\*\*/m,
};

/** Level 1: Validate plan structure. Returns error messages (empty = pass). */
export function validatePlanStructure(content: string): string[] {
	const errors: string[] = [];

	if (!/^## Context/m.test(content)) {
		errors.push("Missing required section: ## Context");
	}

	if (!/^## Tasks/m.test(content)) {
		errors.push("Missing required section: ## Tasks");
		return errors; // can't check tasks without section
	}

	const taskCount = (content.match(TASK_HEADER_G) ?? []).length;
	if (taskCount === 0) {
		errors.push("## Tasks section has no task entries (### Task N:)");
	} else if (taskCount > 15) {
		errors.push(`Too many tasks (${taskCount}). Maximum is 15. Split into smaller plans.`);
	}

	// Extract individual task blocks and check fields
	const tasksSection = content.slice(content.search(/^## Tasks/m));
	const firstNewline = tasksSection.indexOf("\n");
	const nextSection = firstNewline >= 0 ? tasksSection.slice(firstNewline).search(/^## /m) : -1;
	const tasksContent =
		nextSection >= 0 ? tasksSection.slice(0, firstNewline + nextSection) : tasksSection;

	const taskHeaders = [...tasksContent.matchAll(/^### Task (\d+):.*$/gm)];
	for (let i = 0; i < taskHeaders.length; i++) {
		const start = taskHeaders[i]!.index!;
		const end = i + 1 < taskHeaders.length ? taskHeaders[i + 1]!.index! : tasksContent.length;
		const block = tasksContent.slice(start, end);
		const taskNum = taskHeaders[i]![1];

		for (const [field, re] of Object.entries(FIELD_RES)) {
			if (!re.test(block)) {
				errors.push(`Task ${taskNum}: missing required field **${field}**`);
			}
		}
	}

	if (!/^## Success Criteria/m.test(content)) {
		errors.push("Missing required section: ## Success Criteria");
	} else {
		const scStart = content.search(/^## Success Criteria/m);
		const scContent = content.slice(scStart);
		if (!/`.+`/.test(scContent)) {
			errors.push("Success Criteria must contain at least one backtick-wrapped command");
		}
	}

	return errors;
}

// --- Level 2: Heuristic validation ---

const VAGUE_VERBS_RE =
	/^(improve|update|fix|refactor|clean\s*up|enhance|optimize|modify|adjust|change)\b/i;
const VERIFY_FORMAT_RE = /\S+\.\w+:\S+/;
const REGISTRY_FILES = ["init.ts", "types.ts", "session-state.ts"];

/** Level 2: Heuristic plan quality checks. Returns warning messages (empty = pass). */
export function validatePlanHeuristics(content: string): string[] {
	const warnings: string[] = [];

	// Extract task blocks
	if (!/^## Tasks/m.test(content)) return warnings;

	const tasksSection = content.slice(content.search(/^## Tasks/m));
	const firstNewline = tasksSection.indexOf("\n");
	const nextSection = firstNewline >= 0 ? tasksSection.slice(firstNewline).search(/^## /m) : -1;
	const tasksContent =
		nextSection >= 0 ? tasksSection.slice(0, firstNewline + nextSection) : tasksSection;

	const taskHeaders = [...tasksContent.matchAll(/^### Task (\d+):.*$/gm)];
	const taskBlocks: { num: string; block: string }[] = [];

	for (let i = 0; i < taskHeaders.length; i++) {
		const start = taskHeaders[i]!.index!;
		const end = i + 1 < taskHeaders.length ? taskHeaders[i + 1]!.index! : tasksContent.length;
		taskBlocks.push({ num: taskHeaders[i]![1]!, block: tasksContent.slice(start, end) });
	}

	// Collect all File fields across all tasks for consumer check
	const allFiles: string[] = [];
	for (const { block } of taskBlocks) {
		const fileMatch = block.match(/^\s*-\s*\*\*File\*\*:\s*(.+)$/m);
		if (fileMatch) allFiles.push(fileMatch[1]!);
	}
	const allFilesJoined = allFiles.join(" ");

	for (const { num, block } of taskBlocks) {
		// Check vague Change
		const changeMatch = block.match(/^\s*-\s*\*\*Change\*\*:\s*(.+)$/m);
		if (changeMatch) {
			const changeValue = changeMatch[1]!.trim();
			if (VAGUE_VERBS_RE.test(changeValue)) {
				// Count words after the vague verb
				const words = changeValue.split(/\s+/);
				if (words.length < 6) {
					warnings.push(
						`Task ${num}: Change field is too vague ("${changeValue}"). Be specific about what to do.`,
					);
				}
			}
		}

		// Check Verify format
		const verifyMatch = block.match(/^\s*-\s*\*\*Verify\*\*:\s*(.+)$/m);
		if (verifyMatch) {
			const verifyValue = verifyMatch[1]!.trim();
			if (!VERIFY_FORMAT_RE.test(verifyValue)) {
				warnings.push(
					`Task ${num}: Verify field should reference a test file:function (got "${verifyValue}")`,
				);
			}
		}

		// Check registry file consumer coverage
		const fileMatch = block.match(/^\s*-\s*\*\*File\*\*:\s*(.+)$/m);
		if (fileMatch) {
			const fileValue = fileMatch[1]!;
			for (const registry of REGISTRY_FILES) {
				if (fileValue.includes(registry)) {
					// Check if any OTHER task references a consumer file (not the same registry)
					const hasConsumer = allFilesJoined
						.split(/[\s,]+/)
						.some(
							(f) =>
								!f.includes(registry) &&
								(f.includes("test") ||
									f.includes("spec") ||
									f.includes("doctor") ||
									f.includes("hook") ||
									f.includes("cli")),
						);
					if (!hasConsumer) {
						warnings.push(
							`Task ${num}: File references registry file "${registry}" but no consumer file (test, hook, etc.) found in plan`,
						);
					}
				}
			}
		}
	}

	return warnings;
}

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

const PLAN_EVAL_DIMENSIONS = ["Feasibility", "Completeness", "Clarity"];

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
		const threshold = DEFAULT_PLAN_EVAL_SCORE_THRESHOLD;
		const maxIter = DEFAULT_MAX_PLAN_EVAL_ITERATIONS;

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
