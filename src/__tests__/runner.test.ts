import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config.ts";
import {
	deduplicateErrors,
	runGate,
	runGateAsync,
	shellEscape,
	smartTruncate,
} from "../gates/runner.ts";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-runner-test");
const originalCwd = process.cwd();

beforeEach(() => {
	resetConfigCache();
	resetAllCaches();
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
		// Generate output longer than default max (3500 chars)
		// Use python for portability (brace expansion is bash-only, CI uses sh)
		const result = runGate("long-gate", {
			command: `python3 -c "print('-' * 5000)"`,
			timeout: 3000,
		});
		expect(result.passed).toBe(true);
		// Smart truncation: output should be capped + contain truncation marker
		expect(result.output.length).toBeLessThanOrEqual(3600); // 3500 + marker overhead
		expect(result.output).toContain("chars truncated");
	});
});

describe("runGateAsync", () => {
	it("returns passed: false for failing command", async () => {
		const result = await runGateAsync("fail-gate", {
			command: "echo 'lint error' && exit 1",
			timeout: 3000,
		});
		expect(result.passed).toBe(false);
		expect(result.output).toContain("lint error");
	});

	it("returns passed: true for successful command", async () => {
		const result = await runGateAsync("ok-gate", { command: "echo ok", timeout: 3000 });
		expect(result.passed).toBe(true);
		expect(result.output).toContain("ok");
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

	it("handles 100KB+ input without exceeding maxChars", () => {
		const size = 100_000;
		const maxChars = 2000;
		// Realistic: line-based output with unique markers at head and tail
		const headLine = "src/app.ts(1,1): error TS2322: Type mismatch\n";
		const tailLine = "\nFound 347 errors in 42 files.\n";
		const filler = "x".repeat(size - headLine.length - tailLine.length);
		const input = headLine + filler + tailLine;

		const result = smartTruncate(input, maxChars);

		// Must not exceed limit (plus marker overhead)
		expect(result.length).toBeLessThanOrEqual(maxChars + 50);
		// Head (75%) preserved
		expect(result).toContain("error TS2322");
		// Tail (25%) preserved
		expect(result).toContain("347 errors");
		// Marker present
		expect(result).toContain("chars truncated");
		// Truncated count is reasonable (close to input size minus maxChars)
		const match = result.match(/\((\d+) chars truncated\)/);
		expect(match).not.toBeNull();
		const truncatedChars = Number(match![1]);
		expect(truncatedChars).toBeGreaterThan(size - maxChars - 100);
	});
});

describe("shellEscape", () => {
	it("wraps in single quotes", () => {
		expect(shellEscape("foo")).toBe("'foo'");
	});

	it("escapes single quotes to prevent injection", () => {
		const result = shellEscape("it's");
		expect(result).toBe("'it'\\''s'");
		expect(result).not.toContain("it's");
	});

	it("escapes backticks to prevent command substitution injection", () => {
		// Implementation: backtick → '\`' (split into separate single-quoted segments)
		// e.g. "a`b" → "'a'\\`'b'" so the backtick is never inside a live shell context
		const result = shellEscape("file`rm -rf /`.ts");
		// The result must contain the escaped form \` (backslash + backtick)
		expect(result).toContain("\\`");
		// Verify the raw backtick is neutralized: any ` must be preceded by backslash
		const noEscapeBacktick = result.replace(/\\`/g, "");
		expect(noEscapeBacktick).not.toContain("`");
	});

	it("handles both single quotes and backticks together", () => {
		const result = shellEscape("it's`dangerous`");
		// Single quotes are escaped
		expect(result).not.toContain("it's");
		// Backticks are escaped (any ` in result is preceded by \)
		const noEscapeBacktick = result.replace(/\\`/g, "");
		expect(noEscapeBacktick).not.toContain("`");
	});
});

describe("deduplicateErrors", () => {
	it("collapses repeated error codes into first + summary", () => {
		const lines = Array.from(
			{ length: 10 },
			(_, i) => `src/foo.ts(${i + 1},1): error TS2322: Type mismatch`,
		);
		const result = deduplicateErrors(lines.join("\n"));
		const outputLines = result.split("\n").filter((l) => l.trim());
		expect(outputLines).toHaveLength(2);
		expect(outputLines[0]).toContain("TS2322");
		expect(outputLines[1]).toContain("9 more TS2322");
	});

	it("preserves lines with different error codes", () => {
		const input = [
			"src/a.ts(1,1): error TS2322: Type mismatch",
			"src/b.ts(2,1): error TS2345: Argument not assignable",
			"src/c.py:3: E0308: invalid type",
		].join("\n");
		const result = deduplicateErrors(input);
		expect(result).toContain("TS2322");
		expect(result).toContain("TS2345");
		expect(result).toContain("E0308");
		const outputLines = result.split("\n").filter((l) => l.trim());
		expect(outputLines).toHaveLength(3);
	});

	it("passes through text with no error codes unchanged", () => {
		const input = "some normal output\nwithout error codes\n";
		expect(deduplicateErrors(input)).toBe(input);
	});

	it("handles mixed error codes correctly", () => {
		const lines = [
			...Array.from({ length: 5 }, (_, i) => `src/a.ts(${i},1): error TS2322: Type mismatch`),
			"src/b.ts(1,1): error TS2345: Argument not assignable",
			...Array.from({ length: 3 }, (_, i) => `src/c.ts(${i},1): error TS2322: Type mismatch`),
		];
		const result = deduplicateErrors(lines.join("\n"));
		const outputLines = result.split("\n").filter((l) => l.trim());
		// first TS2322 + summary, TS2345, = 3 lines
		expect(outputLines).toHaveLength(3);
		expect(outputLines[0]).toContain("TS2322");
		expect(outputLines[1]).toContain("7 more TS2322");
		expect(outputLines[2]).toContain("TS2345");
	});
});

describe("runGate: extra_path config (Task 9)", () => {
	it("makes commands in extra_path directories available", () => {
		// Create a fake binary in a custom bin dir
		const customBin = join(TEST_DIR, "custom-bin");
		mkdirSync(customBin, { recursive: true });
		writeFileSync(join(customBin, "my-tool"), "#!/bin/sh\necho 'my-tool output'\n", {
			mode: 0o755,
		});

		// Write qult config with extra_path
		mkdirSync(join(TEST_DIR, ".qult"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, ".qult", "config.json"),
			JSON.stringify({ gates: { extra_path: ["custom-bin"] } }),
		);
		resetConfigCache();

		const result = runGate("custom", { command: "my-tool", timeout: 3000 });
		expect(result.passed).toBe(true);
		expect(result.output).toContain("my-tool output");
	});

	it("extra_path with absolute path also works", () => {
		const customBin = join(TEST_DIR, "abs-bin");
		mkdirSync(customBin, { recursive: true });
		writeFileSync(join(customBin, "abs-tool"), "#!/bin/sh\necho 'abs-tool ok'\n", { mode: 0o755 });

		mkdirSync(join(TEST_DIR, ".qult"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, ".qult", "config.json"),
			JSON.stringify({ gates: { extra_path: [customBin] } }),
		);
		resetConfigCache();

		const result = runGate("abs", { command: "abs-tool", timeout: 3000 });
		expect(result.passed).toBe(true);
		expect(result.output).toContain("abs-tool ok");
	});
});
