import { describe, expect, it } from "vitest";
import {
	checkMutationScore,
	type MutationReport,
	parseMutmutOutput,
	parseStrykerReport,
	suggestPbtForLowScore,
} from "../hooks/detectors/mutation-check.ts";

describe("parseStrykerReport", () => {
	it("parses a minimal valid Stryker JSON report", () => {
		const report = JSON.stringify({
			schemaVersion: "1",
			thresholds: { high: 80, low: 60 },
			files: {
				"src/foo.ts": {
					language: "typescript",
					source: "const x = 1;",
					mutants: [
						{
							id: "1",
							mutatorName: "BooleanLiteral",
							status: "Killed",
							location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
						},
						{
							id: "2",
							mutatorName: "ArithmeticOperator",
							status: "Survived",
							location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } },
						},
					],
				},
			},
		});

		const result = parseStrykerReport(report);
		expect(result).not.toBeNull();
		expect(result!.overallScore).toBe(50); // 1 killed / 2 total = 50%
		expect(result!.fileScores).toHaveLength(1);
		expect(result!.fileScores[0]!.file).toBe("src/foo.ts");
		expect(result!.fileScores[0]!.killed).toBe(1);
		expect(result!.fileScores[0]!.survived).toBe(1);
	});

	it("handles multiple files", () => {
		const report = JSON.stringify({
			schemaVersion: "1",
			thresholds: { high: 80, low: 60 },
			files: {
				"src/a.ts": {
					language: "typescript",
					source: "",
					mutants: [
						{
							id: "1",
							mutatorName: "X",
							status: "Killed",
							location: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
						},
						{
							id: "2",
							mutatorName: "X",
							status: "Killed",
							location: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
						},
					],
				},
				"src/b.ts": {
					language: "typescript",
					source: "",
					mutants: [
						{
							id: "3",
							mutatorName: "X",
							status: "Survived",
							location: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
						},
					],
				},
			},
		});

		const result = parseStrykerReport(report);
		expect(result).not.toBeNull();
		// 2 killed / 3 total ≈ 66.67%
		expect(result!.overallScore).toBeCloseTo(66.67, 0);
		expect(result!.fileScores).toHaveLength(2);
	});

	it("returns null for invalid JSON", () => {
		expect(parseStrykerReport("{not valid json")).toBeNull();
	});

	it("returns null for JSON without files field", () => {
		expect(parseStrykerReport('{"schemaVersion":"1"}')).toBeNull();
	});
});

describe("parseMutmutOutput", () => {
	it("parses 'X / Y mutants killed' format", () => {
		const text = "Results: 15 / 20 mutants killed";
		const result = parseMutmutOutput(text);
		expect(result).not.toBeNull();
		expect(result!.overallScore).toBe(75);
		expect(result!.fileScores).toHaveLength(0);
	});

	it("parses 'Mutation score: N%' format", () => {
		const text = "Mutation score: 82.5%\nSome other output";
		const result = parseMutmutOutput(text);
		expect(result).not.toBeNull();
		expect(result!.overallScore).toBe(82.5);
	});

	it("prefers killed/total over score percentage when both present", () => {
		const text = "10 / 20 mutants killed\nMutation score: 99%";
		const result = parseMutmutOutput(text);
		expect(result).not.toBeNull();
		expect(result!.overallScore).toBe(50);
	});

	it("returns null for unrecognized output", () => {
		expect(parseMutmutOutput("All tests passed. No mutation info.")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseMutmutOutput("")).toBeNull();
	});
});

describe("checkMutationScore", () => {
	it("returns PendingFix when score is below threshold", () => {
		const fixes = checkMutationScore(40, 60);
		expect(fixes).toHaveLength(1);
		expect(fixes[0]!.gate).toBe("mutation-test");
		expect(fixes[0]!.errors[0]).toContain("40");
	});

	it("returns empty array when score meets threshold", () => {
		const fixes = checkMutationScore(80, 60);
		expect(fixes).toHaveLength(0);
	});

	it("returns empty array when score equals threshold", () => {
		const fixes = checkMutationScore(60, 60);
		expect(fixes).toHaveLength(0);
	});

	it("returns empty array when threshold is 0 (disabled)", () => {
		const fixes = checkMutationScore(10, 0);
		expect(fixes).toHaveLength(0);
	});
});

describe("suggestPbtForLowScore", () => {
	it("suggests PBT when score < 70%", () => {
		const report: MutationReport = {
			overallScore: 55,
			fileScores: [{ file: "src/foo.ts", score: 55, killed: 5, survived: 4 }],
		};
		const suggestions = suggestPbtForLowScore(report);
		expect(suggestions.length).toBeGreaterThan(0);
		expect(suggestions[0]).toContain("property-based");
	});

	it("does not suggest PBT when score >= 70%", () => {
		const report: MutationReport = {
			overallScore: 85,
			fileScores: [{ file: "src/foo.ts", score: 85, killed: 17, survived: 3 }],
		};
		const suggestions = suggestPbtForLowScore(report);
		expect(suggestions).toHaveLength(0);
	});

	it("lists files with low scores in suggestions", () => {
		const report: MutationReport = {
			overallScore: 50,
			fileScores: [
				{ file: "src/a.ts", score: 30, killed: 3, survived: 7 },
				{ file: "src/b.ts", score: 90, killed: 9, survived: 1 },
			],
		};
		const suggestions = suggestPbtForLowScore(report);
		expect(suggestions.some((s) => s.includes("src/a.ts"))).toBe(true);
		expect(suggestions.some((s) => s.includes("src/b.ts"))).toBe(false);
	});
});
