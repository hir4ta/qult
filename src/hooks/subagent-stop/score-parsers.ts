export interface ReviewScores {
	correctness: number;
	design: number;
	security: number;
}

const REVIEW_DIMENSIONS = ["Correctness", "Design", "Security"] as const;

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
	dimensions: string[],
): Record<string, number> | null {
	const result: Record<string, number> = {};
	for (const dim of dimensions) {
		const val = parseDimensionScore(output, dim);
		if (val === null) return null;
		result[dim] = val;
	}
	return result;
}
