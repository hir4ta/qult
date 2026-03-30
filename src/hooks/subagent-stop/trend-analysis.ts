export type Trend = "improving" | "stagnant" | "regressing";

export function detectTrend(history: number[]): Trend {
	if (history.length < 2) return "stagnant";
	const prev = history[history.length - 2]!;
	const curr = history[history.length - 1]!;
	if (curr > prev) return "improving";
	if (curr < prev) return "regressing";
	return "stagnant";
}

export function findWeakestDimension(dimensions: Record<string, number>): {
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
