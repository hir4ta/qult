import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-test-quality-test");
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("analyzeTestQuality", () => {
	async function analyze(file: string) {
		const { analyzeTestQuality } = await import("../hooks/detectors/test-quality-check.ts");
		return analyzeTestQuality(file);
	}

	it("counts assertions and tests correctly", async () => {
		const file = join(TEST_DIR, "foo.test.ts");
		writeFileSync(
			file,
			`
it("test1", () => {
  expect(1).toBe(1);
  expect(2).toBe(2);
});
it("test2", () => {
  expect(3).toBe(3);
});
`,
		);
		const result = await analyze(file);
		expect(result).not.toBeNull();
		expect(result!.testCount).toBe(2);
		expect(result!.assertionCount).toBe(3);
		expect(result!.avgAssertions).toBe(1.5);
	});

	describe("weak matcher detection", () => {
		it("detects toBeTruthy", async () => {
			const file = join(TEST_DIR, "weak.test.ts");
			writeFileSync(
				file,
				`
it("weak", () => {
  expect(result).toBeTruthy();
});
`,
			);
			const result = await analyze(file);
			const smells = result!.smells.filter((s) => s.type === "weak-matcher");
			expect(smells.length).toBe(1);
			expect(smells[0]!.message).toContain("toBeTruthy()");
		});

		it("detects toBeDefined", async () => {
			const file = join(TEST_DIR, "defined.test.ts");
			writeFileSync(
				file,
				`
it("defined", () => {
  expect(x).toBeDefined();
});
`,
			);
			const result = await analyze(file);
			const smells = result!.smells.filter((s) => s.type === "weak-matcher");
			expect(smells.length).toBe(1);
			expect(smells[0]!.message).toContain("toBeDefined()");
		});
	});

	describe("trivial assertion detection", () => {
		it("detects expect(x).toBe(x)", async () => {
			const file = join(TEST_DIR, "trivial.test.ts");
			writeFileSync(
				file,
				`
it("trivial", () => {
  expect(result).toBe(result);
});
`,
			);
			const result = await analyze(file);
			const smells = result!.smells.filter((s) => s.type === "trivial-assertion");
			expect(smells.length).toBe(1);
			expect(smells[0]!.message).toContain("comparing variable to itself");
		});

		it("does not flag expect(a).toBe(b)", async () => {
			const file = join(TEST_DIR, "good.test.ts");
			writeFileSync(
				file,
				`
it("good", () => {
  expect(actual).toBe(expected);
});
`,
			);
			const result = await analyze(file);
			const trivial = result!.smells.filter((s) => s.type === "trivial-assertion");
			expect(trivial.length).toBe(0);
		});
	});

	describe("empty test detection", () => {
		it("detects empty test body", async () => {
			const file = join(TEST_DIR, "empty.test.ts");
			writeFileSync(
				file,
				`
it("todo", () => {});
test("also empty", () => {});
`,
			);
			const result = await analyze(file);
			const empties = result!.smells.filter((s) => s.type === "empty-test");
			expect(empties.length).toBe(2);
		});

		it("detects async empty test", async () => {
			const file = join(TEST_DIR, "asyncempty.test.ts");
			writeFileSync(
				file,
				`
it("async empty", async () => {});
`,
			);
			const result = await analyze(file);
			const empties = result!.smells.filter((s) => s.type === "empty-test");
			expect(empties.length).toBe(1);
		});
	});

	describe("mock overuse detection", () => {
		it("warns when mocks exceed assertions", async () => {
			const file = join(TEST_DIR, "mocky.test.ts");
			writeFileSync(
				file,
				`
it("over-mocked", () => {
  const fn1 = vi.fn();
  const fn2 = vi.fn();
  const fn3 = vi.fn();
  expect(fn1).toHaveBeenCalled();
});
`,
			);
			const result = await analyze(file);
			const mockSmells = result!.smells.filter((s) => s.type === "mock-overuse");
			expect(mockSmells.length).toBe(1);
			expect(mockSmells[0]!.message).toContain("3 mocks vs 1 assertions");
		});

		it("no warning when assertions exceed mocks", async () => {
			const file = join(TEST_DIR, "balanced.test.ts");
			writeFileSync(
				file,
				`
it("balanced", () => {
  const fn = vi.fn();
  fn("hello");
  expect(fn).toHaveBeenCalled();
  expect(fn).toHaveBeenCalledWith("hello");
});
`,
			);
			const result = await analyze(file);
			const mockSmells = result!.smells.filter((s) => s.type === "mock-overuse");
			expect(mockSmells.length).toBe(0);
		});
	});

	describe("implementation-coupled assertion detection", () => {
		it("detects toHaveBeenCalled pattern", async () => {
			const file = join(TEST_DIR, "coupled.test.ts");
			writeFileSync(
				file,
				`
it("coupled", () => {
  expect(spy).toHaveBeenCalledWith("arg");
});
`,
			);
			const result = await analyze(file);
			const coupled = result!.smells.filter((s) => s.type === "impl-coupled");
			expect(coupled.length).toBe(1);
			expect(coupled[0]!.message).toContain("mock calls instead of behavior");
		});
	});

	it("returns null for non-existent file", async () => {
		const result = await analyze(join(TEST_DIR, "nope.test.ts"));
		expect(result).toBeNull();
	});

	it("skips comments in analysis", async () => {
		const file = join(TEST_DIR, "commented.test.ts");
		writeFileSync(
			file,
			`
it("real", () => {
  // expect(result).toBeTruthy();
  expect(result).toBe(42);
});
`,
		);
		const result = await analyze(file);
		const weak = result!.smells.filter((s) => s.type === "weak-matcher");
		expect(weak.length).toBe(0);
	});
});

describe("formatTestQualityWarnings", () => {
	it("formats shallow test warning", async () => {
		const { formatTestQualityWarnings } = await import("../hooks/detectors/test-quality-check.ts");
		const result = {
			testCount: 3,
			assertionCount: 2,
			avgAssertions: 0.67,
			smells: [],
		};
		const warnings = formatTestQualityWarnings("foo.test.ts", result, "Task 1");
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("0.7 assertions/test");
		expect(warnings[0]).toContain("Task 1");
	});

	it("groups multiple smells of same type", async () => {
		const { formatTestQualityWarnings } = await import("../hooks/detectors/test-quality-check.ts");
		const result = {
			testCount: 2,
			assertionCount: 4,
			avgAssertions: 2,
			smells: [
				{ type: "weak-matcher", line: 5, message: "Weak matcher toBeTruthy()" },
				{ type: "weak-matcher", line: 12, message: "Weak matcher toBeDefined()" },
			],
		};
		const warnings = formatTestQualityWarnings("bar.test.ts", result);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("2x weak-matcher");
	});
});
