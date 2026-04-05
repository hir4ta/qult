import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-claim-grounding-test");
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

import { groundClaims } from "../hooks/subagent-stop/claim-grounding.ts";

describe("groundClaims", () => {
	it("returns empty for output with no file references", () => {
		const result = groundClaims("No issues found", TEST_DIR);
		expect(result.ungrounded).toEqual([]);
	});

	it("returns empty for output referencing existing file", () => {
		const filePath = join(TEST_DIR, "src", "foo.ts");
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(filePath, "export function hello() {}");

		const output = "[medium] src/foo.ts:10 — some issue found";
		const result = groundClaims(output, TEST_DIR);
		expect(result.ungrounded).toEqual([]);
	});

	it("returns ungrounded for nonexistent file", () => {
		const output = "[medium] src/nonexistent.ts:10 — some issue";
		const result = groundClaims(output, TEST_DIR);
		expect(result.ungrounded.length).toBe(1);
		expect(result.ungrounded[0]).toContain("src/nonexistent.ts");
	});

	it("returns ungrounded for nonexistent function reference", () => {
		const filePath = join(TEST_DIR, "src", "bar.ts");
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(filePath, "export function existing() {}");

		const output = "[high] src/bar.ts:5 — `missingFunction` has a bug";
		const result = groundClaims(output, TEST_DIR);
		expect(result.ungrounded.length).toBe(1);
		expect(result.ungrounded[0]).toContain("missingFunction");
	});

	it("returns empty when function exists in file", () => {
		const filePath = join(TEST_DIR, "src", "baz.ts");
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(filePath, "export function handleRequest() { return 1; }");

		const output = "[medium] src/baz.ts:1 — `handleRequest` should validate input";
		const result = groundClaims(output, TEST_DIR);
		expect(result.ungrounded).toEqual([]);
	});

	it("handles multiple file references with mixed validity", () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src", "real.ts"), "export const x = 1;");

		const output = [
			"[high] src/real.ts:1 — needs fix",
			"[medium] src/fake.ts:5 — also broken",
		].join("\n");
		const result = groundClaims(output, TEST_DIR);
		expect(result.ungrounded.length).toBe(1);
		expect(result.ungrounded[0]).toContain("src/fake.ts");
	});

	it("is fail-open: does not throw on any input", () => {
		// Various edge cases that should never throw
		expect(() => groundClaims("", TEST_DIR)).not.toThrow();
		expect(() => groundClaims("[medium] — no filepath", TEST_DIR)).not.toThrow();
		expect(() => groundClaims("[medium] \0\0\0:99 — null bytes", TEST_DIR)).not.toThrow();
	});
});
