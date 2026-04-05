import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTestFile, resolveTestFile } from "../hooks/detectors/test-file-resolver.ts";

// Use /tmp to avoid __tests__ in path triggering isTestFile
const TEST_DIR = join(tmpdir(), ".qult-resolver-test");

beforeEach(() => {
	mkdirSync(join(TEST_DIR, "src", "__tests__"), { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("resolveTestFile", () => {
	it("finds foo.test.ts in same directory", () => {
		const src = join(TEST_DIR, "src", "foo.ts");
		const test = join(TEST_DIR, "src", "foo.test.ts");
		writeFileSync(src, "");
		writeFileSync(test, "");
		expect(resolveTestFile(src)).toBe(test);
	});

	it("finds foo.test.ts in __tests__ directory", () => {
		const src = join(TEST_DIR, "src", "foo.ts");
		const test = join(TEST_DIR, "src", "__tests__", "foo.test.ts");
		writeFileSync(src, "");
		writeFileSync(test, "");
		expect(resolveTestFile(src)).toBe(test);
	});

	it("returns null when no test file exists", () => {
		const src = join(TEST_DIR, "src", "bar.ts");
		writeFileSync(src, "");
		expect(resolveTestFile(src)).toBeNull();
	});

	it("returns null for test files themselves", () => {
		const test = join(TEST_DIR, "src", "foo.test.ts");
		writeFileSync(test, "");
		expect(resolveTestFile(test)).toBeNull();
	});

	it("finds spec file variant", () => {
		const src = join(TEST_DIR, "src", "foo.ts");
		const test = join(TEST_DIR, "src", "foo.spec.ts");
		writeFileSync(src, "");
		writeFileSync(test, "");
		expect(resolveTestFile(src)).toBe(test);
	});
});

describe("isTestFile", () => {
	it("detects .test.ts files", () => {
		expect(isTestFile("src/foo.test.ts")).toBe(true);
	});

	it("detects .spec.ts files", () => {
		expect(isTestFile("src/foo.spec.ts")).toBe(true);
	});

	it("detects __tests__ directory", () => {
		expect(isTestFile("src/__tests__/foo.ts")).toBe(true);
	});

	it("detects Python test files", () => {
		expect(isTestFile("tests/test_foo.py")).toBe(true);
	});

	it("detects Go test files", () => {
		expect(isTestFile("pkg/foo_test.go")).toBe(true);
	});

	it("returns false for regular files", () => {
		expect(isTestFile("src/foo.ts")).toBe(false);
	});
});
