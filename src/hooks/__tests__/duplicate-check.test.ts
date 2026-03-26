import { describe, expect, it } from "vitest";
import { buildSearchQuery, extractFunctionSignatures } from "../duplicate-check.js";

describe("duplicate-check", () => {
	describe("extractFunctionSignatures", () => {
		it("extracts TypeScript function declarations", () => {
			const code = `export function processData(input: string): number {\n  return 1;\n}`;
			const sigs = extractFunctionSignatures("src/foo.ts", code);
			expect(sigs).toHaveLength(1);
			expect(sigs[0]!.name).toBe("processData");
			expect(sigs[0]!.params).toBe("input: string");
			expect(sigs[0]!.line).toBe(1);
		});

		it("extracts async function declarations", () => {
			const code = "export async function fetchData(url: string): Promise<Response> {}";
			const sigs = extractFunctionSignatures("src/api.ts", code);
			expect(sigs).toHaveLength(1);
			expect(sigs[0]!.name).toBe("fetchData");
		});

		it("extracts arrow function assignments", () => {
			const code = "export const handleClick = (event: MouseEvent) => {}";
			const sigs = extractFunctionSignatures("src/ui.tsx", code);
			expect(sigs).toHaveLength(1);
			expect(sigs[0]!.name).toBe("handleClick");
		});

		it("extracts Python def statements", () => {
			const code = "def process_data(input_str, count=10):\n    pass";
			const sigs = extractFunctionSignatures("src/main.py", code);
			expect(sigs).toHaveLength(1);
			expect(sigs[0]!.name).toBe("process_data");
			expect(sigs[0]!.params).toBe("input_str, count=10");
		});

		it("extracts Go func declarations", () => {
			const code = "func ProcessData(input string) (int, error) {";
			const sigs = extractFunctionSignatures("src/main.go", code);
			expect(sigs).toHaveLength(1);
			expect(sigs[0]!.name).toBe("ProcessData");
		});

		it("returns empty for non-code files", () => {
			const sigs = extractFunctionSignatures("README.md", "# Hello");
			expect(sigs).toHaveLength(0);
		});

		it("skips private/constructor functions", () => {
			const code = "function _helper() {}\nfunction constructor() {}";
			const sigs = extractFunctionSignatures("src/foo.ts", code);
			expect(sigs).toHaveLength(0);
		});

		it("extracts multiple functions", () => {
			const code = [
				"function a(x: number) {}",
				"function b(y: string) {}",
				"export const c = (z: boolean) => {}",
			].join("\n");
			const sigs = extractFunctionSignatures("src/utils.ts", code);
			expect(sigs).toHaveLength(3);
		});
	});

	describe("buildSearchQuery", () => {
		it("builds natural language query from signatures", () => {
			const sigs = [
				{ name: "processData", file: "src/foo.ts", line: 1, params: "input: string" },
				{ name: "fetchAPI", file: "src/foo.ts", line: 5, params: "url: string" },
			];
			const query = buildSearchQuery(sigs);
			expect(query).toContain("function processData");
			expect(query).toContain("function fetchAPI");
		});

		it("truncates at 500 chars", () => {
			const sigs = Array.from({ length: 50 }, (_, i) => ({
				name: `func${i}WithVeryLongName`,
				file: "f.ts",
				line: i,
				params: "a: string, b: number, c: boolean",
			}));
			const query = buildSearchQuery(sigs);
			expect(query.length).toBeLessThanOrEqual(500);
		});
	});
});
