import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { suggestPbt } from "../hooks/detectors/test-quality-check.ts";

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

	describe("always-true assertion detection", () => {
		it("detects expect(true).toBe(true) in isolation", async () => {
			const file = join(TEST_DIR, "always-tobe.test.ts");
			writeFileSync(
				file,
				`
it("always true", () => {
  expect(true).toBe(true);
});
`,
			);
			const result = await analyze(file);
			const smells = result!.smells.filter((s) => s.type === "always-true");
			expect(smells.length).toBe(1);
			expect(smells[0]!.message).toContain("Always-true");
		});

		it("detects expect(1).toBeTruthy()", async () => {
			const file = join(TEST_DIR, "always-truthy.test.ts");
			writeFileSync(
				file,
				`
it("always truthy", () => {
  expect(1).toBeTruthy();
});
`,
			);
			const result = await analyze(file);
			const smells = result!.smells.filter((s) => s.type === "always-true");
			expect(smells.length).toBe(1);
		});

		it("detects both patterns together", async () => {
			const file = join(TEST_DIR, "always-both.test.ts");
			writeFileSync(
				file,
				`
it("always true", () => {
  expect(true).toBe(true);
  expect(1).toBeTruthy();
});
`,
			);
			const result = await analyze(file);
			const smells = result!.smells.filter((s) => s.type === "always-true");
			expect(smells.length).toBe(2);
		});
	});

	describe("constant-to-constant assertion detection", () => {
		it("detects expect('hello').toBe('hello')", async () => {
			const file = join(TEST_DIR, "const.test.ts");
			writeFileSync(
				file,
				`
it("constant self", () => {
  expect("hello").toBe("hello");
});
`,
			);
			const result = await analyze(file);
			const smells = result!.smells.filter((s) => s.type === "constant-self");
			expect(smells.length).toBe(1);
			expect(smells[0]!.message).toContain("literal compared to itself");
		});
	});

	describe("snapshot-only detection", () => {
		it("detects file with only snapshot assertions", async () => {
			const file = join(TEST_DIR, "snap.test.ts");
			writeFileSync(
				file,
				`
it("snapshot only", () => {
  expect(result).toMatchSnapshot();
});
`,
			);
			const result = await analyze(file);
			const smells = result!.smells.filter((s) => s.type === "snapshot-only");
			expect(smells.length).toBe(1);
			expect(smells[0]!.message).toContain("snapshots");
		});

		it("no warning when snapshot mixed with value assertions", async () => {
			const file = join(TEST_DIR, "mixed.test.ts");
			writeFileSync(
				file,
				`
it("mixed", () => {
  expect(result).toMatchSnapshot();
  expect(result.name).toBe("foo");
});
`,
			);
			const result = await analyze(file);
			const smells = result!.smells.filter((s) => s.type === "snapshot-only");
			expect(smells.length).toBe(0);
		});
	});

	it("returns null for non-existent file", async () => {
		const result = await analyze(join(TEST_DIR, "nope.test.ts"));
		expect(result).toBeNull();
	});

	it("returns null when no test cases found (testCount === 0)", async () => {
		const file = join(TEST_DIR, "no-tests.test.ts");
		writeFileSync(
			file,
			`// This file has no it() or test() calls
const helper = () => 42;
`,
		);
		const result = await analyze(file);
		expect(result).toBeNull();
	});

	describe("beforeEach/afterEach assertion exclusion (Task 11)", () => {
		it("does not count assertions inside beforeEach toward avgAssertions", async () => {
			const file = join(TEST_DIR, "setup-assert.test.ts");
			writeFileSync(
				file,
				`
beforeEach(() => {
  expect(setup).toBeDefined();
  expect(config).not.toBeNull();
});

it("real test", () => {
  expect(result).toBe(42);
});
`,
			);
			const result = await analyze(file);
			expect(result).not.toBeNull();
			expect(result!.testCount).toBe(1);
			// Only the assertion in the it() block should count (not beforeEach's 2)
			expect(result!.assertionCount).toBe(1);
			expect(result!.avgAssertions).toBe(1);
		});

		it("does not count assertions inside afterEach toward avgAssertions", async () => {
			const file = join(TEST_DIR, "teardown-assert.test.ts");
			writeFileSync(
				file,
				`
afterEach(() => {
  expect(cleanupCalled).toBe(true);
});

it("test one", () => {
  expect(value).toBe(1);
  expect(other).toBe(2);
});
`,
			);
			const result = await analyze(file);
			expect(result).not.toBeNull();
			// afterEach assertion excluded; 2 assertions in it()
			expect(result!.assertionCount).toBe(2);
		});
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
			blockingSmells: [],
			isPbt: false,
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
			blockingSmells: [],
			isPbt: false,
		};
		const warnings = formatTestQualityWarnings("bar.test.ts", result);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("2x weak-matcher");
	});
});

describe("new test quality smells", () => {
	async function analyze(file: string) {
		const { analyzeTestQuality } = await import("../hooks/detectors/test-quality-check.ts");
		return analyzeTestQuality(file);
	}

	it("detects async test without await", async () => {
		const file = join(TEST_DIR, "async.test.ts");
		writeFileSync(
			file,
			[
				'it("missing async keyword usage", async () => {',
				"  const result = fetchData();",
				"  expect(result).toBe(42);",
				"});",
			].join("\n"),
		);
		const result = await analyze(file);
		expect(result).not.toBeNull();
		const smell = result!.smells.find((s) => s.type === "async-no-await");
		expect(smell).toBeDefined();
		expect(smell!.message).toContain("await");
	});

	it("does not flag async test with await", async () => {
		const file = join(TEST_DIR, "async-ok.test.ts");
		writeFileSync(
			file,
			[
				'it("async with await", async () => {',
				"  const result = await fetchData();",
				"  expect(result).toBe(42);",
				"});",
			].join("\n"),
		);
		const result = await analyze(file);
		expect(result).not.toBeNull();
		const smell = result!.smells.find((s) => s.type === "async-no-await");
		expect(smell).toBeUndefined();
	});

	it("detects module-level let (shared mutable state)", async () => {
		const file = join(TEST_DIR, "shared.test.ts");
		writeFileSync(
			file,
			[
				"let counter = 0;",
				"",
				'it("increments", () => {',
				"  counter++;",
				"  expect(counter).toBe(1);",
				"});",
			].join("\n"),
		);
		const result = await analyze(file);
		expect(result).not.toBeNull();
		const smell = result!.smells.find((s) => s.type === "shared-mutable-state");
		expect(smell).toBeDefined();
		expect(smell!.message).toContain("mutable state");
	});

	it("detects large test file", async () => {
		const file = join(TEST_DIR, "large.test.ts");
		const testLines = Array.from(
			{ length: 510 },
			(_, i) => `it("test ${i}", () => { expect(${i}).toBe(${i}); });`,
		);
		writeFileSync(file, testLines.join("\n"));
		const result = await analyze(file);
		expect(result).not.toBeNull();
		const smell = result!.smells.find((s) => s.type === "large-test-file");
		expect(smell).toBeDefined();
		expect(smell!.message).toContain("510");
	});

	it("detects snapshot bloat when .snap file exceeds size threshold", async () => {
		const file = join(TEST_DIR, "snapshot.test.ts");
		writeFileSync(file, 'it("renders", () => { expect(tree).toMatchSnapshot(); });\n');

		// Create the __snapshots__ directory and a bloated .snap file
		const snapDir = join(TEST_DIR, "__snapshots__");
		mkdirSync(snapDir, { recursive: true });
		const snapFile = join(snapDir, "snapshot.test.ts.snap");
		writeFileSync(snapFile, "x".repeat(6000)); // > LARGE_SNAPSHOT_CHARS (5000)

		const result = await analyze(file);
		expect(result).not.toBeNull();
		const smell = result!.smells.find((s) => s.type === "snapshot-bloat");
		expect(smell).toBeDefined();
		expect(smell!.message).toContain("snapshot");
	});

	it("does not flag snapshot bloat below threshold", async () => {
		const file = join(TEST_DIR, "small-snap.test.ts");
		writeFileSync(file, 'it("renders", () => { expect(tree).toMatchSnapshot(); });\n');

		const snapDir = join(TEST_DIR, "__snapshots__");
		mkdirSync(snapDir, { recursive: true });
		writeFileSync(join(snapDir, "small-snap.test.ts.snap"), "x".repeat(100));

		const result = await analyze(file);
		expect(result).not.toBeNull();
		const smell = result!.smells.find((s) => s.type === "snapshot-bloat");
		expect(smell).toBeUndefined();
	});
});

describe("PBT-aware test quality", () => {
	async function analyze(file: string) {
		const { analyzeTestQuality } = await import("../hooks/detectors/test-quality-check.ts");
		return analyzeTestQuality(file);
	}

	it("detects PBT file with fc.assert(fc.property(...))", async () => {
		const file = join(TEST_DIR, "pbt.test.ts");
		writeFileSync(
			file,
			`import fc from "fast-check";
it("property test", () => {
  fc.assert(fc.property(fc.integer(), (n) => {
    expect(n + 0).toBe(n);
  }));
});
`,
		);
		const result = await analyze(file);
		expect(result).not.toBeNull();
		expect(result!.isPbt).toBe(true);
	});

	it("PBT file with 1 assertion does NOT trigger few-assertions warning", async () => {
		const file = join(TEST_DIR, "pbt-single.test.ts");
		writeFileSync(
			file,
			`import fc from "fast-check";
it("property test", () => {
  fc.assert(fc.property(fc.integer(), (n) => {
    expect(n + 0).toBe(n);
  }));
});
`,
		);
		const result = await analyze(file);
		expect(result).not.toBeNull();
		expect(result!.isPbt).toBe(true);
		// avgAssertions is 1.0 which would normally trigger warning, but PBT suppresses it
		const { formatTestQualityWarnings } = await import("../hooks/detectors/test-quality-check.ts");
		const warnings = formatTestQualityWarnings("pbt-single.test.ts", result!);
		const fewAssertions = warnings.filter((w) => w.includes("assertions/test"));
		expect(fewAssertions.length).toBe(0);
	});

	it("detects pbt-degenerate-runs smell for numRuns: 1", async () => {
		const file = join(TEST_DIR, "degenerate.test.ts");
		writeFileSync(
			file,
			`import fc from "fast-check";
it("degenerate", () => {
  fc.assert(fc.property(fc.integer(), (n) => {
    expect(n).toBe(n);
  }), { numRuns: 1 });
});
`,
		);
		const result = await analyze(file);
		expect(result).not.toBeNull();
		const smell = result!.smells.find((s) => s.type === "pbt-degenerate-runs");
		expect(smell).toBeDefined();
		expect(smell!.message).toContain("numRuns");
	});

	it("detects pbt-constrained-generator smell for fc.integer({ min: 5, max: 5 })", async () => {
		const file = join(TEST_DIR, "constrained.test.ts");
		writeFileSync(
			file,
			`import fc from "fast-check";
it("constrained", () => {
  fc.assert(fc.property(fc.integer({ min: 5, max: 5 }), (n) => {
    expect(n).toBe(5);
  }));
});
`,
		);
		const result = await analyze(file);
		expect(result).not.toBeNull();
		const smell = result!.smells.find((s) => s.type === "pbt-constrained-generator");
		expect(smell).toBeDefined();
		expect(smell!.message).toContain("min equals max");
	});

	it("regular (non-PBT) file still triggers few-assertions warning normally", async () => {
		const file = join(TEST_DIR, "regular.test.ts");
		writeFileSync(
			file,
			`it("test1", () => {
  expect(1).toBe(1);
});
it("test2", () => {
  expect(2).toBe(2);
});
`,
		);
		const result = await analyze(file);
		expect(result).not.toBeNull();
		expect(result!.isPbt).toBe(false);
		const { formatTestQualityWarnings } = await import("../hooks/detectors/test-quality-check.ts");
		const warnings = formatTestQualityWarnings("regular.test.ts", result!);
		const fewAssertions = warnings.filter((w) => w.includes("assertions/test"));
		expect(fewAssertions.length).toBe(1);
	});
});

describe("PBT recommendation in formatTestQualityWarnings", () => {
	it("includes PBT recommendation for happy-path-only smell in TS file", async () => {
		const { formatTestQualityWarnings } = await import("../hooks/detectors/test-quality-check.ts");
		const result = {
			testCount: 5,
			assertionCount: 10,
			avgAssertions: 2,
			smells: [{ type: "happy-path-only", line: 0, message: "All test descriptions are positive" }],
			blockingSmells: [],
			isPbt: false,
		};
		const warnings = formatTestQualityWarnings("foo.test.ts", result);
		const pbtWarnings = warnings.filter(
			(w) => w.includes("fast-check") || w.includes("property-based"),
		);
		expect(pbtWarnings.length).toBeGreaterThanOrEqual(1);
	});

	it("includes PBT recommendation for missing-boundary smell in TS file", async () => {
		const { formatTestQualityWarnings } = await import("../hooks/detectors/test-quality-check.ts");
		const result = {
			testCount: 5,
			assertionCount: 10,
			avgAssertions: 2,
			smells: [{ type: "missing-boundary", line: 0, message: "No boundary values tested" }],
			blockingSmells: [],
			isPbt: false,
		};
		const warnings = formatTestQualityWarnings("bar.test.ts", result);
		const pbtWarnings = warnings.filter(
			(w) => w.includes("fast-check") || w.includes("property-based"),
		);
		expect(pbtWarnings.length).toBeGreaterThanOrEqual(1);
	});

	it("includes hypothesis recommendation for Python test file", async () => {
		const { formatTestQualityWarnings } = await import("../hooks/detectors/test-quality-check.ts");
		const result = {
			testCount: 5,
			assertionCount: 10,
			avgAssertions: 2,
			smells: [{ type: "happy-path-only", line: 0, message: "All test descriptions are positive" }],
			blockingSmells: [],
			isPbt: false,
		};
		const warnings = formatTestQualityWarnings("test_foo.py", result);
		const pbtWarnings = warnings.filter(
			(w) => w.includes("hypothesis") || w.includes("property-based"),
		);
		expect(pbtWarnings.length).toBeGreaterThanOrEqual(1);
	});

	it("does not include PBT recommendation when isPbt is true", async () => {
		const { formatTestQualityWarnings } = await import("../hooks/detectors/test-quality-check.ts");
		const result = {
			testCount: 5,
			assertionCount: 10,
			avgAssertions: 2,
			smells: [{ type: "happy-path-only", line: 0, message: "All test descriptions are positive" }],
			blockingSmells: [],
			isPbt: true,
		};
		const warnings = formatTestQualityWarnings("foo.test.ts", result);
		const pbtWarnings = warnings.filter(
			(w) => w.includes("fast-check") || w.includes("hypothesis") || w.includes("property-based"),
		);
		expect(pbtWarnings.length).toBe(0);
	});
});

describe("getBlockingTestSmells", () => {
	it("returns PendingFix for empty test body", async () => {
		const file = join(TEST_DIR, "empty.test.ts");
		writeFileSync(file, `import { it } from "vitest";\nit("does nothing", () => {});\n`);
		const { analyzeTestQuality, getBlockingTestSmells } = await import(
			"../hooks/detectors/test-quality-check.ts"
		);
		const result = analyzeTestQuality(file);
		expect(result).not.toBeNull();
		const fixes = getBlockingTestSmells(file, result!);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.gate).toBe("test-quality-check");
		expect(fixes[0]!.errors.some((e) => e.includes("Empty test body"))).toBe(true);
	});

	it("returns PendingFix for always-true assertion", async () => {
		const file = join(TEST_DIR, "always-true.test.ts");
		writeFileSync(
			file,
			`import { it, expect } from "vitest";\nit("trivial", () => { expect(true).toBe(true); });\n`,
		);
		const { analyzeTestQuality, getBlockingTestSmells } = await import(
			"../hooks/detectors/test-quality-check.ts"
		);
		const result = analyzeTestQuality(file);
		expect(result).not.toBeNull();
		const fixes = getBlockingTestSmells(file, result!);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.gate).toBe("test-quality-check");
	});

	it("returns PendingFix for trivial assertion (expect(x).toBe(x))", async () => {
		const file = join(TEST_DIR, "trivial.test.ts");
		writeFileSync(
			file,
			`import { it, expect } from "vitest";\nit("self", () => { const x = 1; expect(x).toBe(x); });\n`,
		);
		const { analyzeTestQuality, getBlockingTestSmells } = await import(
			"../hooks/detectors/test-quality-check.ts"
		);
		const result = analyzeTestQuality(file);
		expect(result).not.toBeNull();
		const fixes = getBlockingTestSmells(file, result!);
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.gate).toBe("test-quality-check");
	});

	it("does NOT return PendingFix for advisory smells like weak-matcher", async () => {
		const file = join(TEST_DIR, "weak.test.ts");
		writeFileSync(
			file,
			`import { it, expect } from "vitest";\nit("weak", () => { expect(foo).toBeTruthy(); });\n`,
		);
		const { analyzeTestQuality, getBlockingTestSmells } = await import(
			"../hooks/detectors/test-quality-check.ts"
		);
		const result = analyzeTestQuality(file);
		expect(result).not.toBeNull();
		const fixes = getBlockingTestSmells(file, result!);
		expect(fixes).toHaveLength(0);
	});
});

describe("PBT weak-matcher relaxation", () => {
	it("does NOT report weak-matcher smells for PBT files", async () => {
		const file = join(TEST_DIR, "pbt.test.ts");
		writeFileSync(
			file,
			`import fc from "fast-check";\nimport { it, expect } from "vitest";\nit("prop", () => { fc.assert(fc.property(fc.integer(), (n) => { expect(n > 0).toBeTruthy(); })); });\n`,
		);
		const { analyzeTestQuality } = await import("../hooks/detectors/test-quality-check.ts");
		const result = analyzeTestQuality(file);
		expect(result).not.toBeNull();
		expect(result!.isPbt).toBe(true);
		const weakSmells = result!.smells.filter((s) => s.type === "weak-matcher");
		expect(weakSmells).toHaveLength(0);
	});

	it("still reports weak-matcher smells for non-PBT files", async () => {
		const file = join(TEST_DIR, "regular.test.ts");
		writeFileSync(
			file,
			`import { it, expect } from "vitest";\nit("weak", () => { expect(foo).toBeTruthy(); });\n`,
		);
		const { analyzeTestQuality } = await import("../hooks/detectors/test-quality-check.ts");
		const result = analyzeTestQuality(file);
		expect(result).not.toBeNull();
		expect(result!.isPbt).toBe(false);
		const weakSmells = result!.smells.filter((s) => s.type === "weak-matcher");
		expect(weakSmells.length).toBeGreaterThan(0);
	});

	it("still reports blocking smells (empty-test) even for PBT files", async () => {
		const file = join(TEST_DIR, "pbt-empty.test.ts");
		writeFileSync(
			file,
			`import fc from "fast-check";\nimport { it, expect } from "vitest";\nit("empty", () => {});\n`,
		);
		const { analyzeTestQuality } = await import("../hooks/detectors/test-quality-check.ts");
		const result = analyzeTestQuality(file);
		expect(result).not.toBeNull();
		expect(result!.smells.some((s) => s.type === "empty-test")).toBe(true);
	});
});

describe("PBT suggestion advisory", () => {
	// Note: suggestPbt uses resolveTestFile which skips paths containing /__tests__/
	// So we use /tmp for these tests to avoid false isTestFile detection
	const PBT_DIR = "/tmp/.tmp-pbt-suggest-test";

	beforeEach(() => {
		mkdirSync(PBT_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(PBT_DIR, { recursive: true, force: true });
	});

	it("returns PBT suggestion for validator files without PBT", () => {
		const implFile = join(PBT_DIR, "validator.ts");
		const testFile = join(PBT_DIR, "validator.test.ts");
		writeFileSync(implFile, `export function validateInput(s: string) { return s.length > 0; }\n`);
		writeFileSync(
			testFile,
			`import { it, expect } from "vitest";\nit("validates", () => { expect(validateInput("a")).toBe(true); });\n`,
		);
		const suggestion = suggestPbt(implFile);
		expect(suggestion).not.toBeNull();
		expect(suggestion).toContain("property-based");
	});

	it("returns null for non-validator files", () => {
		const implFile = join(PBT_DIR, "utils.ts");
		writeFileSync(implFile, `export function add(a: number, b: number) { return a + b; }\n`);
		const suggestion = suggestPbt(implFile);
		expect(suggestion).toBeNull();
	});

	it("returns null for 'format' files (too common, removed from PBT candidates)", () => {
		const implFile = join(PBT_DIR, "date-format.ts");
		const testFile = join(PBT_DIR, "date-format.test.ts");
		writeFileSync(implFile, `export function formatDate(d: Date) { return d.toISOString(); }\n`);
		writeFileSync(
			testFile,
			`import { it, expect } from "vitest";\nit("formats", () => { expect(1).toBe(1); });\n`,
		);
		const suggestion = suggestPbt(implFile);
		expect(suggestion).toBeNull();
	});

	it("returns null when test file already uses PBT", () => {
		const implFile = join(PBT_DIR, "parser.ts");
		const testFile = join(PBT_DIR, "parser.test.ts");
		writeFileSync(implFile, `export function parseConfig(s: string) { return JSON.parse(s); }\n`);
		writeFileSync(
			testFile,
			`import fc from "fast-check";\nimport { it, expect } from "vitest";\nit("prop", () => { fc.assert(fc.property(fc.string(), (s) => { try { parseConfig(s); } catch {} })); });\n`,
		);
		const suggestion = suggestPbt(implFile);
		expect(suggestion).toBeNull();
	});
});
