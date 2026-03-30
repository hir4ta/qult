import type { ReviewScores } from "./score-parsers.ts";
import { detectTrend, findWeakestDimension } from "./trend-analysis.ts";

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
