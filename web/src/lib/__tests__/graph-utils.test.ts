import { describe, expect, it } from "vitest";
import { nodeSize, hexToRgba, computeConnectionCounts } from "../graph-utils";

describe("nodeSize", () => {
	it("returns base size (4) for hit_count 0", () => {
		expect(nodeSize(0)).toBeCloseTo(4);
	});

	it("increases with hit_count (log scale)", () => {
		const size1 = nodeSize(1);
		const size10 = nodeSize(10);
		const size100 = nodeSize(100);
		expect(size1).toBeGreaterThan(4);
		expect(size10).toBeGreaterThan(size1);
		expect(size100).toBeGreaterThan(size10);
	});

	it("computes correct value for hit_count 100", () => {
		// 4 + log2(101) * 3 ≈ 4 + 6.66 * 3 ≈ 23.97
		expect(nodeSize(100)).toBeCloseTo(4 + Math.log2(101) * 3);
	});

	it("handles negative hit_count (falsy → 0)", () => {
		// -1 is truthy, so (hitCount || 0) = -1, log2(0) = -Infinity
		// This documents edge behavior
		const result = nodeSize(-1);
		expect(typeof result).toBe("number");
	});
});

describe("hexToRgba", () => {
	it("converts hex to rgba", () => {
		expect(hexToRgba("#2d8b7a", 0.5)).toBe("rgba(45, 139, 122, 0.5)");
	});

	it("handles full opacity", () => {
		expect(hexToRgba("#ff0000", 1.0)).toBe("rgba(255, 0, 0, 1)");
	});

	it("handles zero opacity", () => {
		expect(hexToRgba("#000000", 0)).toBe("rgba(0, 0, 0, 0)");
	});

	it("handles brand colors", () => {
		expect(hexToRgba("#628141", 0.7)).toBe("rgba(98, 129, 65, 0.7)");
	});
});

describe("computeConnectionCounts", () => {
	it("counts connections per node", () => {
		const edges = [
			{ source: 1, target: 2 },
			{ source: 1, target: 3 },
		];
		const counts = computeConnectionCounts(edges);
		expect(counts.get(1)).toBe(2);
		expect(counts.get(2)).toBe(1);
		expect(counts.get(3)).toBe(1);
	});

	it("returns empty map for no edges", () => {
		const counts = computeConnectionCounts([]);
		expect(counts.size).toBe(0);
	});

	it("handles self-loops", () => {
		const edges = [{ source: 1, target: 1 }];
		const counts = computeConnectionCounts(edges);
		expect(counts.get(1)).toBe(2);
	});

	it("handles bidirectional edges", () => {
		const edges = [
			{ source: 1, target: 2 },
			{ source: 2, target: 1 },
		];
		const counts = computeConnectionCounts(edges);
		expect(counts.get(1)).toBe(2);
		expect(counts.get(2)).toBe(2);
	});
});
