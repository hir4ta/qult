import { describe, expect, it } from "vitest";
import type { CoChangePair, FileRiskScore } from "../proactive.js";
import { getCoChangeHints, getRiskWarning } from "../proactive.js";

describe("proactive context", () => {
	describe("getRiskWarning", () => {
		const scores: FileRiskScore[] = [
			{ file: "src/hooks/post-tool.ts", score: 85, reasons: ["15 changes", "4 bug-fixes"] },
			{ file: "src/store/db.ts", score: 55, reasons: ["8 changes"] },
		];

		it("returns warning for high-risk file (>70)", () => {
			const warning = getRiskWarning("src/hooks/post-tool.ts", scores);
			expect(warning).toContain("High-risk");
			expect(warning).toContain("85");
		});

		it("returns null for low-risk file", () => {
			const warning = getRiskWarning("src/store/db.ts", scores);
			expect(warning).toBeNull();
		});

		it("returns null for unknown file", () => {
			const warning = getRiskWarning("src/new-file.ts", scores);
			expect(warning).toBeNull();
		});
	});

	describe("getCoChangeHints", () => {
		const pairs: CoChangePair[] = [
			{ file: "src/hooks/post-tool.ts", partner: "src/hooks/pending-fixes.ts", count: 12 },
			{ file: "src/hooks/post-tool.ts", partner: "src/hooks/detect.ts", count: 8 },
			{ file: "src/hooks/post-tool.ts", partner: "src/hooks/directives.ts", count: 5 },
			{ file: "src/hooks/post-tool.ts", partner: "src/hooks/state.ts", count: 4 },
		];

		it("returns top 3 co-change partners", () => {
			const hints = getCoChangeHints("src/hooks/post-tool.ts", pairs);
			expect(hints).toHaveLength(3);
			expect(hints).toContain("src/hooks/pending-fixes.ts");
		});

		it("returns empty for unknown file", () => {
			const hints = getCoChangeHints("src/new-file.ts", pairs);
			expect(hints).toHaveLength(0);
		});
	});
});
