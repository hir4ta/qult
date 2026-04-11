import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	parseVerifyField,
	validateTestCoversImpl,
	validateTestFileExists,
	validateTestFunctionExists,
} from "../hooks/detectors/spec-trace-check.ts";

const TEST_DIR = join(tmpdir(), ".qult-spec-trace-test");

beforeEach(() => {
	mkdirSync(join(TEST_DIR, "src", "__tests__"), { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("parseVerifyField", () => {
	it("extracts file and function", () => {
		const result = parseVerifyField("src/__tests__/foo.test.ts:testFoo");
		expect(result).toEqual({
			testFile: "src/__tests__/foo.test.ts",
			testFunction: "testFoo",
		});
	});

	it("handles colon in file path (Windows-style)", () => {
		const result = parseVerifyField("src/__tests__/foo.test.ts:myTest");
		expect(result).toEqual({
			testFile: "src/__tests__/foo.test.ts",
			testFunction: "myTest",
		});
	});

	it("returns null for empty string", () => {
		expect(parseVerifyField("")).toBeNull();
	});

	it("returns null for string without colon separator", () => {
		expect(parseVerifyField("src/__tests__/foo.test.ts")).toBeNull();
	});

	it("handles spaces around colon", () => {
		const result = parseVerifyField("src/__tests__/foo.test.ts : testFoo");
		expect(result).toEqual({
			testFile: "src/__tests__/foo.test.ts",
			testFunction: "testFoo",
		});
	});
});

describe("validateTestFileExists", () => {
	it("returns true when file exists", () => {
		const file = join(TEST_DIR, "src", "__tests__", "foo.test.ts");
		writeFileSync(file, "test('foo', () => {})");
		expect(validateTestFileExists(file)).toBe(true);
	});

	it("returns false when file does not exist", () => {
		expect(validateTestFileExists(join(TEST_DIR, "nonexistent.test.ts"))).toBe(false);
	});
});

describe("validateTestCoversImpl", () => {
	it("detects import from impl", () => {
		const implFile = join(TEST_DIR, "src", "utils.ts");
		const testFile = join(TEST_DIR, "src", "__tests__", "utils.test.ts");
		writeFileSync(implFile, "export function doStuff() { return 1; }");
		writeFileSync(
			testFile,
			'import { doStuff } from "../utils";\nit("testDoStuff", () => { expect(doStuff()).toBe(1); });',
		);

		expect(validateTestCoversImpl(testFile, "testDoStuff", implFile, TEST_DIR)).toBe(true);
	});

	it("returns false when test does not import impl", () => {
		const implFile = join(TEST_DIR, "src", "utils.ts");
		const testFile = join(TEST_DIR, "src", "__tests__", "other.test.ts");
		writeFileSync(implFile, "export function doStuff() { return 1; }");
		writeFileSync(testFile, 'it("testOther", () => { expect(1).toBe(1); });');

		expect(validateTestCoversImpl(testFile, "testOther", implFile, TEST_DIR)).toBe(false);
	});

	it("returns false when test file does not exist", () => {
		const implFile = join(TEST_DIR, "src", "utils.ts");
		expect(
			validateTestCoversImpl(join(TEST_DIR, "nonexistent.test.ts"), "test", implFile, TEST_DIR),
		).toBe(false);
	});

	it("detects import via relative path variants", () => {
		const implFile = join(TEST_DIR, "src", "utils.ts");
		const testFile = join(TEST_DIR, "src", "__tests__", "utils.test.ts");
		writeFileSync(implFile, "export function foo() {}");
		writeFileSync(testFile, 'import { foo } from "../utils.ts";\nit("testFoo", () => { foo(); });');

		expect(validateTestCoversImpl(testFile, "testFoo", implFile, TEST_DIR)).toBe(true);
	});
});

describe("validateTestFunctionExists", () => {
	it("finds it() test function by name", () => {
		const testFile = join(TEST_DIR, "src", "__tests__", "foo.test.ts");
		writeFileSync(
			testFile,
			`it("handles edge case", () => { expect(1).toBe(1); });\nit("normal case", () => {});`,
		);
		expect(validateTestFunctionExists(testFile, "handles edge case")).toBe(true);
		expect(validateTestFunctionExists(testFile, "nonexistent")).toBe(false);
	});

	it("finds test() function by name", () => {
		const testFile = join(TEST_DIR, "src", "__tests__", "bar.test.ts");
		writeFileSync(testFile, `test("should work", () => { expect(true).toBe(true); });`);
		expect(validateTestFunctionExists(testFile, "should work")).toBe(true);
	});

	it("finds describe() block by name", () => {
		const testFile = join(TEST_DIR, "src", "__tests__", "baz.test.ts");
		writeFileSync(testFile, `describe("MyModule", () => { it("works", () => {}); });`);
		expect(validateTestFunctionExists(testFile, "MyModule")).toBe(true);
	});

	it("finds Python test functions", () => {
		const testFile = join(TEST_DIR, "src", "__tests__", "test_foo.py");
		writeFileSync(testFile, `def test_handles_edge_case():\n    assert True`);
		expect(validateTestFunctionExists(testFile, "test_handles_edge_case")).toBe(true);
		expect(validateTestFunctionExists(testFile, "nonexistent")).toBe(false);
	});

	it("returns false for nonexistent file", () => {
		expect(validateTestFunctionExists(join(TEST_DIR, "nope.test.ts"), "test")).toBe(false);
	});
});
