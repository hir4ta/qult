import { describe, expect, it } from "vitest";
import {
	type ClassifiedDiagnostic,
	classifiedToPendingFixes,
	DIAGNOSTIC_MAP,
	parseCargoOutput,
	parsePyrightOutput,
	parseTscOutput,
} from "../hooks/detectors/diagnostic-classifier.ts";

describe("diagnostic-classifier", () => {
	describe("DIAGNOSTIC_MAP", () => {
		it("classifies TS error codes correctly", () => {
			expect(DIAGNOSTIC_MAP.TS2339).toBe("hallucinated-api");
			expect(DIAGNOSTIC_MAP.TS2304).toBe("hallucinated-symbol");
			expect(DIAGNOSTIC_MAP.TS2307).toBe("hallucinated-import");
		});

		it("maps all defined codes to valid categories", () => {
			const validCategories = new Set([
				"hallucinated-api",
				"hallucinated-symbol",
				"hallucinated-import",
				"type-error",
			]);
			for (const [code, category] of Object.entries(DIAGNOSTIC_MAP)) {
				expect(validCategories.has(category), `${code} → ${category} is not a valid category`).toBe(
					true,
				);
			}
		});
	});

	describe("parseTscOutput", () => {
		it("parses multiline tsc output", () => {
			const raw = [
				"src/foo.ts(10,5): error TS2339: Property 'bar' does not exist on type 'Foo'.",
				"src/foo.ts(15,3): error TS2304: Cannot find name 'baz'.",
				"src/utils.ts(2,1): error TS2307: Cannot find module 'nonexistent' or its corresponding type declarations.",
			].join("\n");

			const result = parseTscOutput(raw);
			expect(result).toHaveLength(3);

			expect(result[0]).toEqual({
				code: "TS2339",
				category: "hallucinated-api",
				message: "Property 'bar' does not exist on type 'Foo'.",
				file: "src/foo.ts",
				line: 10,
			});
			expect(result[1]).toEqual({
				code: "TS2304",
				category: "hallucinated-symbol",
				message: "Cannot find name 'baz'.",
				file: "src/foo.ts",
				line: 15,
			});
			expect(result[2]).toEqual({
				code: "TS2307",
				category: "hallucinated-import",
				message: "Cannot find module 'nonexistent' or its corresponding type declarations.",
				file: "src/utils.ts",
				line: 2,
			});
		});

		it("classifies unknown TS codes as unknown", () => {
			const raw = "src/x.ts(1,1): error TS9999: Some future error.";
			const result = parseTscOutput(raw);
			expect(result).toHaveLength(1);
			expect(result[0]!.category).toBe("unknown");
			expect(result[0]!.code).toBe("TS9999");
		});

		it("returns empty array for non-error output", () => {
			expect(parseTscOutput("")).toEqual([]);
			expect(parseTscOutput("Compilation complete.")).toEqual([]);
		});

		it("handles Windows-style paths", () => {
			const raw = "src\\foo.ts(5,2): error TS2339: Property 'x' does not exist on type 'Y'.";
			const result = parseTscOutput(raw);
			expect(result).toHaveLength(1);
			expect(result[0]!.file).toBe("src\\foo.ts");
		});
	});

	describe("parsePyrightOutput", () => {
		it("parses JSON diagnostics", () => {
			const json = JSON.stringify({
				generalDiagnostics: [
					{
						file: "src/main.py",
						range: { start: { line: 5 } },
						rule: "reportMissingImports",
						message: 'Import "nonexistent" could not be resolved',
					},
					{
						file: "src/main.py",
						range: { start: { line: 10 } },
						rule: "reportUndefinedVariable",
						message: 'Variable "xyz" is not defined',
					},
					{
						file: "src/utils.py",
						range: { start: { line: 3 } },
						rule: "reportAttributeAccessIssue",
						message: 'Cannot access attribute "foo" for class "Bar"',
					},
				],
			});

			const result = parsePyrightOutput(json);
			expect(result).toHaveLength(3);

			expect(result[0]).toEqual({
				code: "reportMissingImports",
				category: "hallucinated-import",
				message: 'Import "nonexistent" could not be resolved',
				file: "src/main.py",
				line: 5,
			});
			expect(result[1]!.category).toBe("hallucinated-symbol");
			expect(result[2]!.category).toBe("hallucinated-api");
		});

		it("returns empty array for invalid JSON", () => {
			expect(parsePyrightOutput("not json")).toEqual([]);
			expect(parsePyrightOutput("{}")).toEqual([]);
		});

		it("classifies unknown pyright rules as type-error", () => {
			const json = JSON.stringify({
				generalDiagnostics: [
					{
						file: "x.py",
						range: { start: { line: 1 } },
						rule: "reportSomethingElse",
						message: "Some other error",
					},
				],
			});
			const result = parsePyrightOutput(json);
			expect(result).toHaveLength(1);
			expect(result[0]!.category).toBe("type-error");
		});
	});

	describe("parseCargoOutput", () => {
		it("parses JSONL diagnostics", () => {
			const lines = [
				JSON.stringify({
					reason: "compiler-message",
					message: {
						code: { code: "E0425" },
						message: "cannot find value `xyz` in this scope",
						spans: [{ file_name: "src/main.rs", line_start: 10 }],
					},
				}),
				JSON.stringify({
					reason: "compiler-message",
					message: {
						code: { code: "E0432" },
						message: "unresolved import `nonexistent`",
						spans: [{ file_name: "src/lib.rs", line_start: 3 }],
					},
				}),
				JSON.stringify({
					reason: "compiler-message",
					message: {
						code: { code: "E0599" },
						message: "no method named `foo` found for struct `Bar`",
						spans: [{ file_name: "src/bar.rs", line_start: 20 }],
					},
				}),
				JSON.stringify({ reason: "build-finished", success: false }),
			].join("\n");

			const result = parseCargoOutput(lines);
			expect(result).toHaveLength(3);

			expect(result[0]).toEqual({
				code: "E0425",
				category: "hallucinated-symbol",
				message: "cannot find value `xyz` in this scope",
				file: "src/main.rs",
				line: 10,
			});
			expect(result[1]!.category).toBe("hallucinated-import");
			expect(result[2]!.category).toBe("hallucinated-api");
		});

		it("skips non-compiler-message lines", () => {
			const lines = [
				JSON.stringify({ reason: "build-script-executed" }),
				JSON.stringify({ reason: "build-finished", success: true }),
			].join("\n");
			expect(parseCargoOutput(lines)).toEqual([]);
		});

		it("returns empty array for empty input", () => {
			expect(parseCargoOutput("")).toEqual([]);
		});

		it("handles messages without error code", () => {
			const line = JSON.stringify({
				reason: "compiler-message",
				message: {
					code: null,
					message: "warning: unused variable",
					spans: [{ file_name: "src/main.rs", line_start: 5 }],
				},
			});
			expect(parseCargoOutput(line)).toEqual([]);
		});
	});

	describe("classifiedToPendingFixes", () => {
		it("groups by file and category", () => {
			const diagnostics: ClassifiedDiagnostic[] = [
				{
					code: "TS2339",
					category: "hallucinated-api",
					message: "Property 'a' does not exist",
					file: "src/foo.ts",
					line: 1,
				},
				{
					code: "TS2339",
					category: "hallucinated-api",
					message: "Property 'b' does not exist",
					file: "src/foo.ts",
					line: 5,
				},
				{
					code: "TS2307",
					category: "hallucinated-import",
					message: "Cannot find module 'x'",
					file: "src/bar.ts",
					line: 1,
				},
			];

			const fixes = classifiedToPendingFixes(diagnostics);
			expect(fixes).toHaveLength(2);

			const fooFix = fixes.find((f) => f.file === "src/foo.ts");
			expect(fooFix).toBeDefined();
			expect(fooFix!.gate).toBe("typecheck");
			expect(fooFix!.errors).toHaveLength(2);
			expect(fooFix!.errors[0]).toBe("[hallucinated-api] Property 'a' does not exist");
			expect(fooFix!.errors[1]).toBe("[hallucinated-api] Property 'b' does not exist");

			const barFix = fixes.find((f) => f.file === "src/bar.ts");
			expect(barFix!.errors[0]).toBe("[hallucinated-import] Cannot find module 'x'");
		});

		it("skips unknown category diagnostics", () => {
			const diagnostics: ClassifiedDiagnostic[] = [
				{
					code: "TS9999",
					category: "unknown",
					message: "Something",
					file: "src/x.ts",
					line: 1,
				},
			];
			expect(classifiedToPendingFixes(diagnostics)).toEqual([]);
		});

		it("returns empty array for empty input", () => {
			expect(classifiedToPendingFixes([])).toEqual([]);
		});
	});
});
