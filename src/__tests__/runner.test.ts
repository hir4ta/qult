import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config.ts";
import { runGate, smartTruncate } from "../gates/runner.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-runner-test");
const originalCwd = process.cwd();

beforeEach(() => {
	resetConfigCache();
	mkdirSync(TEST_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("runGate", () => {
	it("returns passed: true for successful command", () => {
		const result = runGate("test-gate", { command: "echo ok", timeout: 3000 });
		expect(result.passed).toBe(true);
		expect(result.name).toBe("test-gate");
		expect(result.output).toContain("ok");
	});

	it("returns passed: false for failing command", () => {
		const result = runGate("fail-gate", { command: "exit 1", timeout: 3000 });
		expect(result.passed).toBe(false);
		expect(result.name).toBe("fail-gate");
	});

	it("returns passed: false with output on failure", () => {
		const result = runGate("err-gate", {
			command: "echo 'error: missing semicolon' >&2 && exit 1",
			timeout: 3000,
		});
		expect(result.passed).toBe(false);
		expect(result.output).toContain("missing semicolon");
	});

	it("substitutes {file} placeholder", () => {
		writeFileSync(join(TEST_DIR, "test.ts"), "const x = 1;\n");
		const filePath = join(TEST_DIR, "test.ts");
		const result = runGate("lint", { command: `cat {file}`, timeout: 3000 }, filePath);
		expect(result.passed).toBe(true);
		expect(result.output).toContain("const x = 1");
	});

	it("handles timeout", () => {
		const result = runGate("slow-gate", { command: "sleep 10", timeout: 100 });
		expect(result.passed).toBe(false);
		expect(result.name).toBe("slow-gate");
	});

	it("truncates long output using smart head+tail", () => {
		// Generate output longer than default max (2000 chars)
		// Use python for portability (brace expansion is bash-only, CI uses sh)
		const result = runGate("long-gate", {
			command: `python3 -c "print('-' * 5000)"`,
			timeout: 3000,
		});
		expect(result.passed).toBe(true);
		// Smart truncation: output should be capped + contain truncation marker
		expect(result.output.length).toBeLessThanOrEqual(2100); // 2000 + marker overhead
		expect(result.output).toContain("chars truncated");
	});
});

describe("smartTruncate", () => {
	it("returns text unchanged if under limit", () => {
		expect(smartTruncate("short text", 100)).toBe("short text");
	});

	it("truncates with head+tail and marker", () => {
		const input = "A".repeat(100);
		const result = smartTruncate(input, 50);
		expect(result).toContain("chars truncated");
		// Head should be ~75% of limit
		expect(result.startsWith("A".repeat(37))).toBe(true);
		// Tail should end with A's
		expect(result.endsWith("A".repeat(13))).toBe(true);
	});

	it("preserves head + tail content", () => {
		const head = "ERROR: first line\n";
		const middle = "x".repeat(3000);
		const tail = "\nSummary: 5 errors found";
		const input = head + middle + tail;
		const result = smartTruncate(input, 200);
		// Head should contain the error
		expect(result).toContain("ERROR: first line");
		// Tail should contain the summary
		expect(result).toContain("errors found");
		expect(result).toContain("chars truncated");
	});
});
