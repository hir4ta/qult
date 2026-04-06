import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { loadConfig } from "../../config.ts";
import { atomicWriteJson } from "../../state/atomic-write.ts";
import { checkCalibration, recordCalibration } from "../../state/calibration.ts";
import {
	clearStageScores,
	getPlanEvalIteration,
	getPlanEvalScoreHistory,
	getReviewIteration,
	getReviewScoreHistory,
	getStageScores,
	readSessionState,
	recordPlanEvalIteration,
	recordReview,
	recordReviewIteration,
	recordStageScores,
	resetPlanEvalIteration,
	resetReviewIteration,
} from "../../state/session-state.ts";
import type { HookEvent } from "../../types.ts";
import { block } from "../respond.ts";
import { groundClaims } from "./claim-grounding.ts";
import { crossValidate } from "./cross-validation.ts";
import { buildPlanEvalBlockMessage } from "./message-builders.ts";
import {
	PLAN_EVAL_DIMENSIONS,
	validatePlanHeuristics,
	validatePlanStructure,
} from "./plan-validators.ts";
import {
	parseAdversarialScores,
	parseDimensionScores,
	parseQualityScores,
	parseSecurityScores,
	parseSpecScores,
} from "./score-parsers.ts";
import { detectTrend, findWeakestDimension } from "./trend-analysis.ts";

/** Read-only enforcement: detect if a reviewer created unauthorized commits.
 *  Known reviewers must be read-only — they may read files but must NOT write, edit, or commit.
 *  We detect commits (not uncommitted changes, since the code under review IS uncommitted).
 *  Compares HEAD commit timestamp against session's last_commit_at. */
const READ_ONLY_REVIEWERS = new Set([
	"qult-spec-reviewer",
	"qult-quality-reviewer",
	"qult-security-reviewer",
	"qult-adversarial-reviewer",
	"qult-plan-evaluator",
]);

function checkReadOnlyViolation(normalized: string): void {
	if (!READ_ONLY_REVIEWERS.has(normalized)) return;

	try {
		const state = readSessionState();
		if (!state.last_commit_at) return;

		const headTime = execSync("git log -1 --format=%aI HEAD", {
			timeout: 5000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		if (headTime && new Date(headTime) > new Date(state.last_commit_at)) {
			const commitMsg = execSync("git log -1 --format=%s HEAD", {
				timeout: 5000,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
			block(
				`${normalized} violated read-only constraint: unauthorized commit detected ("${commitMsg.slice(0, 100)}"). ` +
					"Reviewers must NOT commit. Revert with `git reset --soft HEAD~1` and rerun the review.",
			);
		}
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("process.exit")) throw err;
		/* fail-open: git not available or other error */
	}
}

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

// Adversarial reviewer verdicts
const ADVERSARIAL_PASS_RE = /^Adversarial:\s*PASS/im;
const ADVERSARIAL_FAIL_RE = /^Adversarial:\s*FAIL/im;

// Plan evaluator verdicts
const PLAN_PASS_RE = /^Plan:\s*PASS/im;
const PLAN_REVISE_RE = /^Plan:\s*REVISE/im;

/** SubagentStop: verify subagent output quality */
export default async function subagentStop(ev: HookEvent): Promise<void> {
	if (ev.stop_hook_active) return;

	const agentType = ev.agent_type;
	const output = ev.last_assistant_message;

	// fail-open: no agent_type → allow (not a qult agent)
	if (!agentType) return;

	// Normalize: plugin agents use "qult:spec-reviewer", standalone use "qult-spec-reviewer"
	const normalized = agentType.replace(/:/g, "-");

	// Read-only enforcement: reviewers must not modify files or create commits
	try {
		checkReadOnlyViolation(normalized);
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("process.exit")) throw err;
		/* fail-open */
	}

	// Known reviewer with empty output → block (empty review is not a valid review)
	const KNOWN_REVIEWERS = new Set([
		"qult-spec-reviewer",
		"qult-quality-reviewer",
		"qult-security-reviewer",
		"qult-adversarial-reviewer",
		"qult-plan-evaluator",
	]);
	if (!output && KNOWN_REVIEWERS.has(normalized)) {
		block(
			`${normalized} returned empty output. The reviewer must produce a verdict, scores, and findings. Rerun the review.`,
		);
	}
	if (!output) return;

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
	} else if (normalized === "qult-adversarial-reviewer") {
		validateStageReviewer(
			output,
			ADVERSARIAL_PASS_RE,
			ADVERSARIAL_FAIL_RE,
			parseAdversarialScores,
			"Adversarial",
		);
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
	const scores = scoreParser(output);

	// Strict validation: require verdict (PASS/FAIL is mandatory for structured review)
	if (!hasVerdict) {
		block(
			`${stageName} reviewer output must include '${stageName}: PASS' or '${stageName}: FAIL' as the first line. Rerun the review.`,
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

		// Record scores AFTER floor check: if block() fires it throws, skipping recordStageScores,
		// so no partial state persists when a dimension is below the floor.
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

		// Record stage scores AFTER floor check passes — ensures no partial state
		try {
			recordStageScores(stageName, scoreEntries);
		} catch {
			/* fail-open */
		}

		// Score-findings consistency check
		checkScoreFindingsConsistency(output, scoreEntries, stageName);

		// L5: Extract findings for Flywheel persistence
		try {
			extractFindings(output, stageName);
		} catch {
			/* fail-open */
		}

		// Claim grounding: verify file/symbol references in reviewer output
		try {
			const grounding = groundClaims(output, process.cwd());
			if (grounding.ungrounded.length > 0) {
				block(
					`${stageName}: reviewer references ungrounded claims:\n${grounding.ungrounded.map((c) => `  - ${c}`).join("\n")}\nFix references and re-run /qult:review.`,
				);
			}
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("process.exit")) throw err;
			/* fail-open */
		}

		// Cross-validation: check reviewer claims against computational detector results
		try {
			const cv = crossValidate(output, stageName);
			if (cv.contradictions.length > 0) {
				block(
					`${stageName}: cross-validation contradiction(s):\n${cv.contradictions.map((c) => `  - ${c}`).join("\n")}\nReconcile findings and re-run /qult:review.`,
				);
			}
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("process.exit")) throw err;
			/* fail-open */
		}

		// Check if all stages are complete → run aggregate check
		tryAggregateCheck();
	}
}

/** Check if all review stages have scores and run aggregate check if so.
 *  Fires when all 4 stages (Spec/Quality/Security/Adversarial) have valid scores.
 *  /qult:review always runs all 4 stages sequentially, so this fires after Adversarial. */
const ALL_STAGES = ["Spec", "Quality", "Security", "Adversarial"];

function tryAggregateCheck(): void {
	try {
		const stageScores = getStageScores();
		const completedStages = ALL_STAGES.filter(
			(s) => stageScores[s] && typeof stageScores[s] === "object" && !Array.isArray(stageScores[s]),
		);
		const hasAllStages = completedStages.length === ALL_STAGES.length;

		if (hasAllStages) {
			checkAggregateScore(ALL_STAGES);
		}
		// If only 3 base stages (Spec/Quality/Security), warn that Adversarial is required
		// but do not trigger aggregate check yet — wait for Adversarial to appear.
		// This prevents incomplete reviews from being accidentally approved.
		if (
			completedStages.length === 3 &&
			completedStages.includes("Security") &&
			!completedStages.includes("Adversarial")
		) {
			process.stderr.write(
				`[qult] Review warning: only ${completedStages.length}/4 stages completed. Adversarial reviewer has not run yet. All 4 stages are required for a complete review. Waiting for Adversarial stage...\n`,
			);
		}
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("process.exit")) throw err;
		// fail-open
	}
}

/** Check consistency between findings severity and scores.
 *  - Critical/high findings + all scores 4+ → block (contradiction)
 *  - All 5/5 + no findings → block (perfect score requires evidence of thoroughness)
 *  - Any dimension < 4 + no findings → block (low score must cite evidence) */
function checkScoreFindingsConsistency(
	output: string,
	scores: Record<string, number>,
	stageName: string,
): void {
	const criticalHighCount = (output.match(/\[(critical|high)\]/gi) ?? []).length;
	const hasFindings = FINDING_RE.test(output);
	const allScoresHigh = Object.values(scores).every((v) => v >= 4);
	const allPerfect = Object.values(scores).every((v) => v === 5);
	const hasNoIssuesDeclaration = NO_ISSUES_RE.test(output);

	if (criticalHighCount > 0 && allScoresHigh) {
		block(
			`${stageName}: PASS but ${criticalHighCount} critical/high finding(s) with all scores 4+/5. Reconcile findings with scores and rerun the review.`,
		);
	}

	// Evidence-based scoring: low scores must cite specific findings
	const belowThreshold = Object.entries(scores).filter(([, v]) => v < 4);
	if (belowThreshold.length > 0 && !hasFindings) {
		const dims = belowThreshold.map(([name, score]) => `${name} (${score}/5)`).join(", ");
		block(
			`${stageName}: ${dims} scored below 4/5 but no findings cited. Low scores must include at least one [severity] file — description finding as evidence. Rerun the review with concrete findings.`,
		);
	}

	// Perfect scores with no findings — block (requires evidence of thoroughness)
	if (allPerfect && !hasFindings && !hasNoIssuesDeclaration) {
		block(
			`${stageName}: all dimensions 5/5 with no findings and no explicit 'No issues found' declaration. Perfect scores require either findings or an explicit declaration. Rerun the review.`,
		);
	}
}

/** Check aggregate score across all completed stages. Blocks if below threshold.
 *  @param stages — Stage names to include in aggregate (e.g. ["Spec", "Quality", "Security", "Adversarial"]) */
function checkAggregateScore(stages: string[]): void {
	try {
		const stageScores = getStageScores();

		const allScores = stages.flatMap((s) =>
			Object.values(stageScores[s]!).filter((v) => typeof v === "number" && v >= 1 && v <= 5),
		);
		// Each stage should have 2 dimensions; if not, skip (fail-open)
		if (allScores.length !== stages.length * 2) return;
		const aggregate = allScores.reduce((sum, v) => sum + v, 0);
		const maxScore = allScores.length * 5;
		const config = loadConfig();
		const threshold = config.review.score_threshold;
		const maxIter = config.review.max_iterations;

		// Score distribution bias detection (stderr warnings, non-blocking)
		try {
			const uniqueScores = new Set(allScores);
			if (uniqueScores.size === 1) {
				process.stderr.write(
					`[qult] Review bias warning: all ${allScores.length} dimensions scored identically (${allScores[0]}/5). This may indicate template answers.\n`,
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
			// Cross-session calibration: record and check for bias
			try {
				recordCalibration(aggregate, stageScores);
				const calibrationWarnings = checkCalibration();
				for (const w of calibrationWarnings) {
					process.stderr.write(`[qult] ${w.message}\n`);
				}
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

			let msg = `Review aggregate ${aggregate}/${maxScore} below threshold ${threshold}/${maxScore}. Iteration ${iterCount}/${maxIter}.`;
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
			`[qult] Max review iterations (${maxIter}) reached. Aggregate ${aggregate}/${maxScore} below threshold ${threshold}/${maxScore}. Proceeding anyway.\n`,
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
 *  Separator: em-dash (—), en-dash (–), or plain hyphen surrounded by spaces. */
export function extractFindings(output: string, stageName: string): void {
	const findingRe =
		/\[(critical|high|medium|low)\]\s*(\S+?)(?::\d+)?\s+(?:[—–]|\s-\s)\s*(.+?)(?:\n|$)/gi;
	for (const match of output.matchAll(findingRe)) {
		_currentFindings.push({
			file: normalize(match[2]!), // normalize paths (./src/file.ts → src/file.ts)
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
