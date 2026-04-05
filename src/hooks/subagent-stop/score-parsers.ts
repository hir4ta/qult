/** Legacy reviewer scores (3 dimensions, /15 max) */
export interface ReviewScores {
	correctness: number;
	design: number;
	security: number;
}

/** Spec reviewer scores (2 dimensions, /10 max) */
export interface SpecReviewScores {
	completeness: number;
	accuracy: number;
}

/** Quality reviewer scores (2 dimensions, /10 max) */
export interface QualityReviewScores {
	design: number;
	maintainability: number;
}

/** Security reviewer scores (2 dimensions, /10 max) */
export interface SecurityReviewScores {
	vulnerability: number;
	hardening: number;
}

const REVIEW_DIMENSIONS = ["Correctness", "Design", "Security"] as const;
const SPEC_DIMENSIONS = ["Completeness", "Accuracy"] as const;
const QUALITY_DIMENSIONS = ["Design", "Maintainability"] as const;
const SECURITY_DIMENSIONS = ["Vulnerability", "Hardening"] as const;
const ADVERSARIAL_DIMENSIONS = ["EdgeCases", "LogicCorrectness"] as const;

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse a single named dimension score from output. Order-independent. */
function parseDimensionScore(output: string, name: string): number | null {
	const re = new RegExp(`${escapeRegex(name)}[=:]\\s*(\\d+)`, "i");
	const m = re.exec(output);
	if (!m) return null;
	const val = Number.parseInt(m[1]!, 10);
	return val >= 1 && val <= 5 ? val : null;
}

/** Parse reviewer scores by dimension name. Order-independent, name-validated. */
export function parseScores(output: string): ReviewScores | null {
	const correctness = parseDimensionScore(output, REVIEW_DIMENSIONS[0]);
	const design = parseDimensionScore(output, REVIEW_DIMENSIONS[1]);
	const security = parseDimensionScore(output, REVIEW_DIMENSIONS[2]);
	if (correctness === null || design === null || security === null) return null;
	return { correctness, design, security };
}

/** Generic dimension score parser. Extracts each dimension independently by name. */
export function parseDimensionScores(
	output: string,
	dimensions: string[] | readonly string[],
): Record<string, number> | null {
	const result: Record<string, number> = {};
	for (const dim of dimensions) {
		const val = parseDimensionScore(output, dim);
		if (val === null) return null;
		result[dim] = val;
	}
	return result;
}

/** Parse spec reviewer scores. */
export function parseSpecScores(output: string): SpecReviewScores | null {
	const scores = parseDimensionScores(output, SPEC_DIMENSIONS);
	if (!scores) return null;
	return { completeness: scores.Completeness!, accuracy: scores.Accuracy! };
}

/** Parse quality reviewer scores. */
export function parseQualityScores(output: string): QualityReviewScores | null {
	const scores = parseDimensionScores(output, QUALITY_DIMENSIONS);
	if (!scores) return null;
	return { design: scores.Design!, maintainability: scores.Maintainability! };
}

/** Parse security reviewer scores. */
export function parseSecurityScores(output: string): SecurityReviewScores | null {
	const scores = parseDimensionScores(output, SECURITY_DIMENSIONS);
	if (!scores) return null;
	return { vulnerability: scores.Vulnerability!, hardening: scores.Hardening! };
}

/** Adversarial reviewer scores (2 dimensions, /10 max) */
export interface AdversarialReviewScores {
	edgeCases: number;
	logicCorrectness: number;
}

/** Parse adversarial reviewer scores. */
export function parseAdversarialScores(output: string): AdversarialReviewScores | null {
	const scores = parseDimensionScores(output, ADVERSARIAL_DIMENSIONS);
	if (!scores) return null;
	return { edgeCases: scores.EdgeCases!, logicCorrectness: scores.LogicCorrectness! };
}
