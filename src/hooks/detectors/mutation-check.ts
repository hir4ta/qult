import { calculateMutationTestMetrics } from "mutation-testing-metrics";
import type { PendingFix } from "../../types.ts";

export interface MutationReport {
	overallScore: number;
	fileScores: { file: string; score: number; killed: number; survived: number }[];
}

/** Parse a Stryker JSON report into a MutationReport. Returns null on failure (fail-open). */
export function parseStrykerReport(jsonContent: string): MutationReport | null {
	try {
		const raw = JSON.parse(jsonContent);
		if (!raw.files || typeof raw.files !== "object") return null;

		const result = calculateMutationTestMetrics(raw);
		const metrics = result.systemUnderTestMetrics.metrics;
		const overallScore = Number.isNaN(metrics.mutationScore)
			? 0
			: Math.round(metrics.mutationScore * 100) / 100;

		// Build per-file scores from the raw report data (avoids tree path reconstruction)
		const fileScores: MutationReport["fileScores"] = [];
		for (const [filePath, fileResult] of Object.entries(raw.files)) {
			const mutants = (fileResult as { mutants?: { status: string }[] }).mutants ?? [];
			let killed = 0;
			let survived = 0;
			for (const m of mutants) {
				if (m.status === "Killed" || m.status === "Timeout") killed++;
				else if (m.status === "Survived" || m.status === "NoCoverage") survived++;
			}
			const total = killed + survived;
			const score = total === 0 ? 0 : Math.round((killed / total) * 10000) / 100;
			fileScores.push({ file: filePath, score, killed, survived });
		}

		return { overallScore, fileScores };
	} catch {
		return null;
	}
}

/** Parse mutmut text output into a MutationReport. Returns null on failure (fail-open). */
export function parseMutmutOutput(text: string): MutationReport | null {
	try {
		// Try "X / Y mutants killed" first
		const killedMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*mutants killed/i);
		if (killedMatch) {
			const killed = Number.parseInt(killedMatch[1]!, 10);
			const total = Number.parseInt(killedMatch[2]!, 10);
			if (total === 0) return null;
			const overallScore = Math.round((killed / total) * 10000) / 100;
			return { overallScore, fileScores: [] };
		}

		// Fallback: "Mutation score: N%"
		const scoreMatch = text.match(/Mutation score:\s*([\d.]+)%/i);
		if (scoreMatch) {
			const overallScore = Number.parseFloat(scoreMatch[1]!);
			if (Number.isNaN(overallScore)) return null;
			return { overallScore, fileScores: [] };
		}

		return null;
	} catch {
		return null;
	}
}

/** Check mutation score against threshold. Returns PendingFix[] (empty if passing or disabled). */
export function checkMutationScore(score: number, threshold: number): PendingFix[] {
	if (threshold <= 0) return [];
	if (score >= threshold) return [];

	return [
		{
			file: "mutation-test-report",
			errors: [
				`Mutation score ${score}% is below threshold ${threshold}%. Improve test quality to kill more mutants.`,
			],
			gate: "mutation-test",
		},
	];
}

/** Suggest property-based testing for files with low mutation scores (< 70%). */
export function suggestPbtForLowScore(report: MutationReport, _testDir?: string): string[] {
	if (report.overallScore >= 70) return [];

	const suggestions: string[] = [
		`Mutation score is ${report.overallScore}% — consider property-based testing (fast-check, hypothesis) to improve mutant kill rate.`,
	];

	for (const f of report.fileScores) {
		if (f.score < 70) {
			suggestions.push(
				`${f.file}: score ${f.score}% (${f.survived} survived mutants) — candidate for property-based testing.`,
			);
		}
	}

	return suggestions;
}
