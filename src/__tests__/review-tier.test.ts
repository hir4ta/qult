import { describe, expect, it } from "vitest";
import type { QultConfig } from "../config.ts";
import { computeReviewTier } from "../review-tier.ts";

const DEFAULT_CONFIG = {
	review: {
		score_threshold: 34,
		max_iterations: 3,
		required_changed_files: 5,
		dimension_floor: 4,
		require_human_approval: false,
	},
} as QultConfig;

describe("computeReviewTier", () => {
	it("returns skip for 1-2 files without plan", () => {
		expect(computeReviewTier(1, false, DEFAULT_CONFIG)).toBe("skip");
		expect(computeReviewTier(2, false, DEFAULT_CONFIG)).toBe("skip");
	});

	it("returns light for 3-4 files without plan", () => {
		expect(computeReviewTier(3, false, DEFAULT_CONFIG)).toBe("light");
		expect(computeReviewTier(4, false, DEFAULT_CONFIG)).toBe("light");
	});

	it("returns standard for files at required_changed_files threshold", () => {
		expect(computeReviewTier(5, false, DEFAULT_CONFIG)).toBe("standard");
		expect(computeReviewTier(7, false, DEFAULT_CONFIG)).toBe("standard");
	});

	it("returns deep for 8+ files", () => {
		expect(computeReviewTier(8, false, DEFAULT_CONFIG)).toBe("deep");
		expect(computeReviewTier(20, false, DEFAULT_CONFIG)).toBe("deep");
	});

	it("returns standard when plan is active regardless of file count", () => {
		expect(computeReviewTier(1, true, DEFAULT_CONFIG)).toBe("standard");
		expect(computeReviewTier(3, true, DEFAULT_CONFIG)).toBe("standard");
	});

	it("returns deep when plan active and 8+ files", () => {
		expect(computeReviewTier(8, true, DEFAULT_CONFIG)).toBe("deep");
	});

	it("returns skip for 0 files", () => {
		expect(computeReviewTier(0, false, DEFAULT_CONFIG)).toBe("skip");
	});

	it("respects custom required_changed_files threshold", () => {
		const config = {
			...DEFAULT_CONFIG,
			review: { ...DEFAULT_CONFIG.review, required_changed_files: 3 },
		} as QultConfig;
		// With threshold=3, 3 files → standard (not light)
		expect(computeReviewTier(3, false, config)).toBe("standard");
		// 2 files → skip (below light threshold of 3)
		expect(computeReviewTier(2, false, config)).toBe("skip");
	});
});
