// Score parsing: strict → colon → loose fallback
const SCORE_STRICT_RE = /Score:\s*Correctness=(\d+)\s+Design=(\d+)\s+Security=(\d+)/i;
const SCORE_COLON_RE = /Correctness[=:]\s*(\d+).*?Design[=:]\s*(\d+).*?Security[=:]\s*(\d+)/i;
const SCORE_LOOSE_RE = /Score:.*?[=:]\s*(\d+).*?[=:]\s*(\d+).*?[=:]\s*(\d+)/i;

export interface ReviewScores {
	correctness: number;
	design: number;
	security: number;
}

/** Parse reviewer scores with graduated fallback (strict → colon → loose).
 *  Returns null if any dimension is outside valid range (1-5). */
export function parseScores(output: string): ReviewScores | null {
	for (const re of [SCORE_STRICT_RE, SCORE_COLON_RE, SCORE_LOOSE_RE]) {
		const m = re.exec(output);
		if (m) {
			const correctness = Number.parseInt(m[1]!, 10);
			const design = Number.parseInt(m[2]!, 10);
			const security = Number.parseInt(m[3]!, 10);
			if (correctness < 1 || correctness > 5) return null;
			if (design < 1 || design > 5) return null;
			if (security < 1 || security > 5) return null;
			return { correctness, design, security };
		}
	}
	return null;
}

/** Generic dimension score parser. Builds regex from dimension names with graduated fallback. */
export function parseDimensionScores(
	output: string,
	dimensions: string[],
): Record<string, number> | null {
	// Strict: Score: Dim1=N Dim2=N Dim3=N
	const strictPattern = dimensions.map((d) => `${d}=(\\d+)`).join("\\s+");
	const strictRe = new RegExp(`Score:\\s*${strictPattern}`, "i");

	// Colon: Dim1: N ... Dim2: N
	const colonParts = dimensions.map((d) => `${d}[=:]\\s*(\\d+)`).join(".*?");
	const colonRe = new RegExp(colonParts, "i");

	for (const re of [strictRe, colonRe]) {
		const m = re.exec(output);
		if (m) {
			const result: Record<string, number> = {};
			for (let i = 0; i < dimensions.length; i++) {
				const val = Number.parseInt(m[i + 1]!, 10);
				if (val < 1 || val > 5) return null;
				result[dimensions[i]!] = val;
			}
			return result;
		}
	}
	return null;
}
