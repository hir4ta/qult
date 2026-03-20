/** Node radius based on hit_count (log scale). */
export function nodeSize(hitCount: number): number {
	return 4 + Math.log2((hitCount || 0) + 1) * 3;
}

/** Convert hex color + opacity to rgba string. */
export function hexToRgba(hex: string, opacity: number): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/** Count connections per node from edge list. */
export function computeConnectionCounts(
	edges: { source: number; target: number }[],
): Map<number, number> {
	const counts = new Map<number, number>();
	for (const edge of edges) {
		counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
		counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
	}
	return counts;
}
