import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../config.ts";
import { atomicWriteJson } from "../../state/atomic-write.ts";
import {
	clearStageScores,
	getPlanEvalIteration,
	getPlanEvalScoreHistory,
	getReviewIteration,
	getReviewScoreHistory,
	getStageScores,
	recordPlanEvalIteration,
	recordReview,
	recordReviewIteration,
	recordStageScores,
	resetPlanEvalIteration,
	resetReviewIteration,
} from "../../state/session-state.ts";
import type { HookEvent } from "../../types.ts";
import { block } from "../respond.ts";
import { buildPlanEvalBlockMessage } from "./message-builders.ts";
import {
	PLAN_EVAL_DIMENSIONS,
	validatePlanHeuristics,
	validatePlanStructure,
} from "./plan-validators.ts";
import {
	parseDimensionScores,
	parseQualityScores,
	parseSecurityScores,
	parseSpecScores,
} from "./score-parsers.ts";
import { detectTrend, findWeakestDimension } from "./trend-analysis.ts";

// [severity] file:line pattern or "No issues found"
const SEVERITY_PATTERN = /\[(critical|high|medium|low)\]/;
const FINDING_RE = new RegExp(SEVERITY_PATTERN.source, "i");
const NO_ISSUES_RE = /no issues found/i;
// 3-stage review verdicts
const SPEC_PASS_RE = /^Spec:\s*PASS/im;
const SPEC_FAIL_RE = /^Spec:\s*FAIL/im;
const QUALITY_PASS_RE = /^Quality:\s*PASS/im;
const QUALITY_FAIL_RE = /^Quality:\s*FAIL/im;
const SECURITY_PASS_RE = /^Security:\s*PASS/im;
const SECURITY_FAIL_RE = /^Security:\s*FAIL/im;

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

	// Normalize: plugin agents use "qult:spec-reviewer", standalone use "qult-spec-reviewer"
	const normalized = agentType.replace(/:/g, "-");

	if (normalized === "qult-spec-reviewer") {
		validateStageReviewer(output, SPEC_PASS_RE, SPEC_FAIL_RE, parseSpecScores, "Spec");
	} else if (normalized === "qult-quality-reviewer") {
		validateStageReviewer(output, QUALITY_PASS_RE, QUALITY_FAIL_RE, parseQualityScores, "Quality");
	} else if (normalized === "qult-security-reviewer") {
		validateStageReviewer(
			output,
			SECURITY_PASS_RE,
			SECURITY_FAIL_RE,
			parseSecurityScores,
			"Security",
		);
		// After final stage, check aggregate across all 3 stages
		checkAggregateScore();
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

		// Level 3: Require plan-evaluator to have run at least once
		if (getPlanEvalIteration() === 0) {
			block(
				"Plan has not been evaluated. Run /qult:plan-generator with plan-evaluator, or run the plan-evaluator manually before proceeding.",
			);
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

/** Generic validation for 3-stage review agents (spec, quality, security).
 *  Validates output format: verdict + scores + findings. Blocks on FAIL verdict.
 *  Enforces dimension floor: any single dimension below floor → block. */
function validateStageReviewer(
	output: string,
	passRe: RegExp,
	failRe: RegExp,
	scoreParser: (output: string) => object | null,
	stageName: string,
): void {
	const hasVerdict = passRe.test(output) || failRe.test(output);
	const hasFindings = FINDING_RE.test(output) || NO_ISSUES_RE.test(output);
	const scores = scoreParser(output);
	const hasScore = scores !== null;

	// Soft validation: accept if any signal is present
	if (!hasVerdict && !hasFindings && !hasScore) {
		block(
			`${stageName} reviewer output must include: (1) '${stageName}: PASS' or '${stageName}: FAIL', (2) Score line, or (3) findings. Rerun the review.`,
		);
	}

	if (failRe.test(output)) {
		block(
			`${stageName}: FAIL. Fix the issues found by the ${stageName.toLowerCase()} reviewer and re-run /qult:review.`,
		);
	}

	// PASS verdict but no parseable scores — block to require structured output
	if (passRe.test(output) && !scores) {
		block(
			`${stageName}: PASS but no parseable scores found. Output must include 'Score: Dim1=N Dim2=N'. Rerun the review.`,
		);
	}

	// Dimension floor enforcement: block if any dimension is below the floor
	if (passRe.test(output) && scores) {
		const scoreEntries = scores as Record<string, number>;

		// Record stage scores BEFORE floor check.
		// block() throws, so recordStageScores must come first to persist scores.
		// This is intentional: /qult:review always reruns all 3 stages per cycle,
		// so partial stage scores are cleared at next aggregate check.
		try {
			recordStageScores(stageName, scoreEntries);
		} catch {
			/* fail-open */
		}

		const floor = loadConfig().review.dimension_floor;
		const belowFloor = Object.entries(scoreEntries).filter(
			([, v]) => typeof v === "number" && v < floor,
		);
		if (belowFloor.length > 0) {
			const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
			const dims = belowFloor.map(([name, score]) => `${capitalize(name)} (${score}/5)`).join(", ");
			block(
				`${stageName}: PASS but ${dims} below minimum ${floor}/5. Fix these dimensions and re-run /qult:review.`,
			);
		}

		// Score-findings consistency check
		checkScoreFindingsConsistency(output, scoreEntries, stageName);

		// L5: Extract findings for Flywheel persistence
		try {
			extractFindings(output, stageName);
		} catch {
			/* fail-open */
		}
	}
}

/** Check consistency between findings severity and scores.
 *  - Critical/high findings + all scores 4+ → block (contradiction)
 *  - All 5/5 + no findings → warn to stderr (suspicious but not blocked) */
function checkScoreFindingsConsistency(
	output: string,
	scores: Record<string, number>,
	stageName: string,
): void {
	const criticalHighCount = (output.match(/\[(critical|high)\]/gi) ?? []).length;
	const allScoresHigh = Object.values(scores).every((v) => v >= 4);
	const allPerfect = Object.values(scores).every((v) => v === 5);
	const noFindings = !FINDING_RE.test(output);

	if (criticalHighCount > 0 && allScoresHigh) {
		block(
			`${stageName}: PASS but ${criticalHighCount} critical/high finding(s) with all scores 4+/5. Reconcile findings with scores and rerun the review.`,
		);
	}

	if (allPerfect && noFindings) {
		process.stderr.write(
			`[qult] ${stageName}: all dimensions 5/5 with no findings — verify review thoroughness.\n`,
		);
	}
}

/** Check aggregate score across all 3 stages. Blocks if below threshold. */
function checkAggregateScore(): void {
	try {
		const stageScores = getStageScores();
		const stages = ["Spec", "Quality", "Security"];
		// Only check if all 3 stages have valid score objects
		if (
			!stages.every(
				(s) =>
					stageScores[s] && typeof stageScores[s] === "object" && !Array.isArray(stageScores[s]),
			)
		)
			return;

		const allScores = stages.flatMap((s) =>
			Object.values(stageScores[s]!).filter((v) => typeof v === "number" && v >= 1 && v <= 5),
		);
		// If any stage has no valid scores, skip aggregate (fail-open)
		if (allScores.length !== 6) return;
		const aggregate = allScores.reduce((sum, v) => sum + v, 0);
		const config = loadConfig();
		const threshold = config.review.score_threshold;
		const maxIter = config.review.max_iterations;

		// Score distribution bias detection (stderr warnings, non-blocking)
		try {
			const uniqueScores = new Set(allScores);
			if (uniqueScores.size === 1) {
				process.stderr.write(
					`[qult] Review bias warning: all 6 dimensions scored identically (${allScores[0]}/5). This may indicate template answers.\n`,
				);
			} else if (Math.max(...allScores) - Math.min(...allScores) < 2) {
				process.stderr.write(
					`[qult] Review bias warning: score range is ${Math.min(...allScores)}-${Math.max(...allScores)}/5 (low variance). Consider if reviewers differentiated sufficiently.\n`,
				);
			}
		} catch {
			/* fail-open */
		}

		try {
			recordReviewIteration(aggregate);
		} catch {
			/* fail-open */
		}

		const iterCount = getReviewIteration();
		const history = getReviewScoreHistory();

		if (aggregate >= threshold) {
			// Aggregate passes — clear stage scores and record review
			clearStageScores();
			resetReviewIteration();
			// L5: Agentic Flywheel — persist findings for pattern detection
			try {
				const mergedHistory = persistReviewFindings();
				if (mergedHistory) detectRepeatedPatterns(mergedHistory);
			} catch {
				/* fail-open */
			}
			recordReview();
			return;
		}

		// Clear stage scores and findings for next iteration
		clearStageScores();
		_currentFindings = [];

		if (iterCount < maxIter) {
			// Find weakest dimension across all stages
			const allDims: Record<string, number> = {};
			for (const stage of stages) {
				for (const [dim, score] of Object.entries(stageScores[stage]!)) {
					const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
					allDims[capitalize(dim)] = score;
				}
			}
			const weakest = findWeakestDimension(allDims);
			const trend = detectTrend(history);

			let msg = `Review aggregate ${aggregate}/30 below threshold ${threshold}/30. Iteration ${iterCount}/${maxIter}.`;
			if (weakest) {
				if (trend === "improving" && history.length >= 2) {
					const prev = history[history.length - 2]!;
					msg += ` Score improved ${prev}→${aggregate}. Focus on: ${weakest.name} (${weakest.score}/5).`;
				} else if (trend === "regressing" && history.length >= 2) {
					const prev = history[history.length - 2]!;
					msg += ` Score regressed ${prev}→${aggregate}. Revert recent ${weakest.name.toLowerCase()}-related changes.`;
				} else {
					msg += ` Weakest: ${weakest.name} (${weakest.score}/5). Fix and re-run /qult:review.`;
				}
			}
			block(msg);
		}

		// Max iterations reached — allow with warning to stderr
		process.stderr.write(
			`[qult] Max review iterations (${maxIter}) reached. Aggregate ${aggregate}/30 below threshold ${threshold}/30. Proceeding anyway.\n`,
		);
		resetReviewIteration();
		recordReview();
	} catch (err) {
		// fail-open — but re-throw block() exits
		if (err instanceof Error && err.message.startsWith("process.exit")) throw err;
	}
}

// ── L5: Agentic Flywheel — findings persistence & pattern detection ──

interface FindingRecord {
	file: string;
	severity: string;
	description: string;
	stage: string;
	timestamp: string;
}

const FINDINGS_HISTORY_FILE = "review-findings-history.json";
const MAX_FINDINGS = 100;

let _currentFindings: FindingRecord[] = [];

/** Extract findings from reviewer output and cache for persistence.
 *  Separator: em-dash (—) or en-dash (–) only. Plain hyphen excluded to avoid misparsing hyphenated filenames. */
export function extractFindings(output: string, stageName: string): void {
	const findingRe = /\[(critical|high|medium|low)\]\s*(\S+?)(?::\d+)?\s+[—–]\s+(.+?)(?:\n|$)/gi;
	for (const match of output.matchAll(findingRe)) {
		_currentFindings.push({
			file: match[2]!,
			severity: match[1]!.toLowerCase(),
			description: match[3]!.trim().slice(0, 200),
			stage: stageName,
			timestamp: new Date().toISOString(),
		});
	}
}

/** Persist accumulated findings to history file. Returns merged history for detectRepeatedPatterns. */
function persistReviewFindings(): FindingRecord[] | null {
	if (_currentFindings.length === 0) return null;
	const historyPath = join(process.cwd(), ".qult", ".state", FINDINGS_HISTORY_FILE);
	let history: FindingRecord[] = [];
	try {
		if (existsSync(historyPath)) {
			history = JSON.parse(readFileSync(historyPath, "utf-8"));
		}
	} catch {
		history = [];
	}
	history.push(..._currentFindings);
	if (history.length > MAX_FINDINGS) {
		history = history.slice(-MAX_FINDINGS);
	}
	atomicWriteJson(historyPath, history);
	_currentFindings = [];
	return history;
}

/** Detect repeated findings and suggest rules. Takes merged history to avoid redundant I/O. */
function detectRepeatedPatterns(history: FindingRecord[]): void {
	// Count findings per file (medium+ only, threshold 3+ to avoid single-session noise)
	const fileCounts: Record<string, number> = {};
	for (const f of history) {
		if (f.severity === "low") continue;
		fileCounts[f.file] = (fileCounts[f.file] ?? 0) + 1;
	}
	for (const [file, count] of Object.entries(fileCounts)) {
		if (count >= 3) {
			process.stderr.write(
				`[qult] Flywheel: ${file} has ${count} review findings. Consider adding a .claude/rules/ entry.\n`,
			);
		}
	}
	// Count similar descriptions (3+ occurrences)
	const descCounts: Record<string, number> = {};
	for (const f of history) {
		const key = f.description
			.toLowerCase()
			.replace(/\S+\.\w{1,4}\b/g, "FILE")
			.slice(0, 80);
		descCounts[key] = (descCounts[key] ?? 0) + 1;
	}
	for (const [desc, count] of Object.entries(descCounts)) {
		if (count >= 3) {
			process.stderr.write(
				`[qult] Flywheel: recurring pattern (${count}x): "${desc}". Consider encoding as a .claude/rules/ rule.\n`,
			);
		}
	}
}

/** Reset current findings cache (for tests). */
export function resetFindingsCache(): void {
	_currentFindings = [];
}
