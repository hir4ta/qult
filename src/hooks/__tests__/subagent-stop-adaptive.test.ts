import { describe, expect, it } from "vitest";
import {
	buildPlanEvalBlockMessage,
	buildReviewBlockMessage,
	type ReviewScores,
} from "../subagent-stop/index.ts";

describe("buildReviewBlockMessage", () => {
	const base: ReviewScores = { correctness: 3, design: 2, security: 4 };

	it("first iteration shows weakest dimension", () => {
		const msg = buildReviewBlockMessage(base, [9], 9, 12, 1, 3);
		expect(msg).toContain("9/15");
		expect(msg).toContain("12/15");
		expect(msg).toContain("Design");
		expect(msg).toContain("2/5");
		expect(msg).toContain("Weakest dimension");
	});

	it("improving trend shows encouragement", () => {
		const msg = buildReviewBlockMessage(base, [7, 9], 9, 12, 2, 3);
		expect(msg).toContain("improved 7→9");
		expect(msg).toContain("Design");
		expect(msg).toContain("Focus on remaining weak dimension");
	});

	it("stagnant trend suggests different approach", () => {
		const msg = buildReviewBlockMessage(base, [9, 9], 9, 12, 2, 3);
		expect(msg).toContain("stuck at");
		expect(msg).toContain("fundamentally different");
	});

	it("regressing trend suggests reverting", () => {
		const scores: ReviewScores = { correctness: 3, design: 2, security: 3 };
		const msg = buildReviewBlockMessage(scores, [10, 8], 8, 12, 2, 3);
		expect(msg).toContain("regressed 10→8");
		expect(msg).toContain("revert");
		expect(msg).toContain("design");
	});
});

describe("buildPlanEvalBlockMessage", () => {
	it("first iteration shows weakest dimension", () => {
		const dims = { Feasibility: 3, Completeness: 2, Clarity: 4 };
		const msg = buildPlanEvalBlockMessage(dims, [9], 9, 10, 1, 2);
		expect(msg).toContain("Completeness");
		expect(msg).toContain("2/5");
	});

	it("improving plan eval", () => {
		const dims = { Feasibility: 3, Completeness: 3, Clarity: 3 };
		const msg = buildPlanEvalBlockMessage(dims, [7, 9], 9, 10, 2, 2);
		expect(msg).toContain("improved 7→9");
	});

	it("regressing plan eval", () => {
		const dims = { Feasibility: 2, Completeness: 3, Clarity: 3 };
		const msg = buildPlanEvalBlockMessage(dims, [9, 8], 8, 10, 2, 2);
		expect(msg).toContain("regressed 9→8");
		expect(msg).toContain("feasibility");
	});
});
