import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeComplexity } from "../hooks/detectors/complexity-check.ts";

const TMP_DIR = join(process.cwd(), ".tmp-complexity-test");

beforeAll(() => {
	mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
	rmSync(TMP_DIR, { recursive: true, force: true });
});

function writeTmp(name: string, content: string): string {
	const p = join(TMP_DIR, name);
	writeFileSync(p, content);
	return p;
}

describe("computeComplexity", () => {
	it("simple function has cyclomatic 1", async () => {
		const file = writeTmp(
			"simple.ts",
			`function foo() { return 1; }`,
		);
		const result = await computeComplexity(file);
		expect(result).not.toBeNull();
		expect(result!.functions.length).toBe(1);
		expect(result!.functions[0]!.cyclomatic).toBe(1);
		expect(result!.functions[0]!.cognitive).toBe(0);
	});

	it("calculates cyclomatic complexity for if-else chains", async () => {
		const file = writeTmp(
			"branches.ts",
			`function check(x) {
  if (x > 0) {
    return 1;
  } else if (x < 0) {
    return -1;
  } else {
    return 0;
  }
}`,
		);
		const result = await computeComplexity(file);
		expect(result).not.toBeNull();
		const fn = result!.functions[0]!;
		// 1 base + 2 if/else-if branches
		expect(fn.cyclomatic).toBeGreaterThanOrEqual(3);
		expect(fn.name).toBe("check");
	});

	it("calculates cognitive complexity with nesting penalty", async () => {
		const file = writeTmp(
			"nested.ts",
			`function nested(a, b) {
  if (a) {
    if (b) {
      return true;
    }
  }
  for (let i = 0; i < 10; i++) {
    while (a) {
      break;
    }
  }
}`,
		);
		const result = await computeComplexity(file);
		expect(result).not.toBeNull();
		const fn = result!.functions[0]!;
		// Cognitive should be higher than cyclomatic due to nesting
		expect(fn.cognitive).toBeGreaterThan(fn.cyclomatic - 1);
		expect(fn.cyclomatic).toBeGreaterThanOrEqual(5);
	});

	it("detects arrow functions", async () => {
		const file = writeTmp(
			"arrow.ts",
			`const f = () => {
  if (true) { return 1; }
  return 0;
};`,
		);
		const result = await computeComplexity(file);
		expect(result).not.toBeNull();
		expect(result!.functions.length).toBeGreaterThanOrEqual(1);
		// Should have at least 1 branch (if)
		const arrowFn = result!.functions.find((f) => f.cyclomatic >= 2);
		expect(arrowFn).toBeDefined();
	});

	it("warns for functions exceeding complexity threshold", async () => {
		// Build a function with many branches
		const branches = Array.from({ length: 20 }, (_, i) => `  if (x === ${i}) return ${i};`).join("\n");
		const file = writeTmp(
			"complex.ts",
			`function big(x) {\n${branches}\n  return -1;\n}`,
		);
		const result = await computeComplexity(file);
		expect(result).not.toBeNull();
		expect(result!.warnings.length).toBeGreaterThan(0);
		expect(result!.warnings[0]).toContain("cyclomatic complexity");
	});

	it("warns for large functions", async () => {
		const lines = Array.from({ length: 60 }, (_, i) => `  const x${i} = ${i};`).join("\n");
		const file = writeTmp(
			"large.ts",
			`function large() {\n${lines}\n}`,
		);
		const result = await computeComplexity(file);
		expect(result).not.toBeNull();
		expect(result!.warnings.some((w) => w.includes("lines"))).toBe(true);
	});

	it("detects Python functions", async () => {
		const file = writeTmp(
			"check.py",
			`def check(x):
    if x > 0:
        return 1
    elif x < 0:
        return -1
    return 0
`,
		);
		const result = await computeComplexity(file);
		expect(result).not.toBeNull();
		expect(result!.functions.length).toBeGreaterThanOrEqual(1);
		expect(result!.functions[0]!.name).toBe("check");
	});

	it("detects Go functions", async () => {
		const file = writeTmp(
			"main.go",
			`package main

func check(x int) int {
	if x > 0 {
		return 1
	}
	return 0
}
`,
		);
		const result = await computeComplexity(file);
		expect(result).not.toBeNull();
		expect(result!.functions.length).toBeGreaterThanOrEqual(1);
		expect(result!.functions[0]!.name).toBe("check");
	});

	it("returns null for unsupported extensions", async () => {
		const file = writeTmp("style.css", "body { color: red; }");
		const result = await computeComplexity(file);
		expect(result).toBeNull();
	});

	it("returns null for non-existent files", async () => {
		const result = await computeComplexity("/nonexistent/path.ts");
		expect(result).toBeNull();
	});
});
