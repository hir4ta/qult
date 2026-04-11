import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config.ts";
import {
	deduplicateErrors,
	runCoverageGate,
	runGate,
	runGateAsync,
	shellEscape,
	smartTruncate,
} from "../gates/runner.ts";
import { closeDb, getDb, getProjectId, setProjectPath, useTestDb } from "../state/db.ts";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-runner-test");
const originalCwd = process.cwd();

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	resetConfigCache();
	resetAllCaches();
	mkdirSync(TEST_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	closeDb();
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
		const result = runGate("long-gate", {
			command: `python3 -c "print('-' * 5000)"`,
			timeout: 3000,
		});
		expect(result.passed).toBe(true);
		expect(result.output.length).toBeLessThanOrEqual(3600);
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

	it("classifies typecheck output when gate name is typecheck", async () => {
		const tscOutput =
			"src/foo.ts(10,5): error TS2339: Property 'bar' does not exist on type 'Foo'.";
		const result = await runGateAsync("typecheck", {
			command: `echo '${tscOutput}' >&2 && exit 1`,
			timeout: 3000,
		});
		expect(result.passed).toBe(false);
		expect(result.classifiedDiagnostics).toBeDefined();
		expect(result.classifiedDiagnostics).toHaveLength(1);
		expect(result.classifiedDiagnostics![0]!.category).toBe("hallucinated-api");
		expect(result.classifiedDiagnostics![0]!.code).toBe("TS2339");
	});

	it("does not classify for non-typecheck gates", async () => {
		const result = await runGateAsync("lint", {
			command: "echo 'lint error' && exit 1",
			timeout: 3000,
		});
		expect(result.classifiedDiagnostics).toBeUndefined();
	});

	it("uses structured_command when available for typecheck", async () => {
		// Simulate pyright --outputjson output
		const pyrightJson = JSON.stringify({
			generalDiagnostics: [
				{
					file: "src/main.py",
					range: { start: { line: 5 } },
					rule: "reportMissingImports",
					message: 'Import "nonexistent" could not be resolved',
				},
			],
		});
		const result = await runGateAsync("typecheck", {
			command: "exit 1",
			structured_command: `echo '${pyrightJson}' && exit 1`,
			timeout: 3000,
		});
		expect(result.passed).toBe(false);
		expect(result.classifiedDiagnostics).toBeDefined();
		expect(result.classifiedDiagnostics).toHaveLength(1);
		expect(result.classifiedDiagnostics![0]!.category).toBe("hallucinated-import");
	});

	it("leaves classifiedDiagnostics undefined when output has no parseable errors", async () => {
		const result = await runGateAsync("typecheck", {
			command: "echo 'some non-error output' && exit 1",
			timeout: 3000,
		});
		// Should still fail, but no classified diagnostics since nothing parsed
		expect(result.passed).toBe(false);
		expect(result.classifiedDiagnostics).toBeUndefined();
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
		expect(result.startsWith("A".repeat(37))).toBe(true);
		expect(result.endsWith("A".repeat(13))).toBe(true);
	});

	it("preserves head + tail content", () => {
		const head = "ERROR: first line\n";
		const middle = "x".repeat(3000);
		const tail = "\nSummary: 5 errors found";
		const input = head + middle + tail;
		const result = smartTruncate(input, 200);
		expect(result).toContain("ERROR: first line");
		expect(result).toContain("errors found");
		expect(result).toContain("chars truncated");
	});

	it("handles 100KB+ input without exceeding maxChars", () => {
		const size = 100_000;
		const maxChars = 2000;
		const headLine = "src/app.ts(1,1): error TS2322: Type mismatch\n";
		const tailLine = "\nFound 347 errors in 42 files.\n";
		const filler = "x".repeat(size - headLine.length - tailLine.length);
		const input = headLine + filler + tailLine;

		const result = smartTruncate(input, maxChars);

		expect(result.length).toBeLessThanOrEqual(maxChars + 50);
		expect(result).toContain("error TS2322");
		expect(result).toContain("347 errors");
		expect(result).toContain("chars truncated");
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
		const result = shellEscape("file`rm -rf /`.ts");
		expect(result).toContain("\\`");
		const noEscapeBacktick = result.replace(/\\`/g, "");
		expect(noEscapeBacktick).not.toContain("`");
	});

	it("handles both single quotes and backticks together", () => {
		const result = shellEscape("it's`dangerous`");
		expect(result).not.toContain("it's");
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
		expect(outputLines).toHaveLength(3);
		expect(outputLines[0]).toContain("TS2322");
		expect(outputLines[1]).toContain("7 more TS2322");
		expect(outputLines[2]).toContain("TS2345");
	});
});

describe("runGate: extra_path config (Task 9)", () => {
	it("makes commands in extra_path directories available", () => {
		const customBin = join(TEST_DIR, "custom-bin");
		mkdirSync(customBin, { recursive: true });
		writeFileSync(join(customBin, "my-tool"), "#!/bin/sh\necho 'my-tool output'\n", {
			mode: 0o755,
		});

		// Write config via DB
		const db = getDb();
		const projectId = getProjectId();
		db.prepare(
			"INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)",
		).run(projectId, "gates.extra_path", JSON.stringify(["custom-bin"]));
		resetConfigCache();

		const result = runGate("custom", { command: "my-tool", timeout: 3000 });
		expect(result.passed).toBe(true);
		expect(result.output).toContain("my-tool output");
	});

	it("extra_path with absolute path also works", () => {
		const customBin = join(TEST_DIR, "abs-bin");
		mkdirSync(customBin, { recursive: true });
		writeFileSync(join(customBin, "abs-tool"), "#!/bin/sh\necho 'abs-tool ok'\n", { mode: 0o755 });

		const db = getDb();
		const projectId = getProjectId();
		db.prepare(
			"INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)",
		).run(projectId, "gates.extra_path", JSON.stringify([customBin]));
		resetConfigCache();

		const result = runGate("abs", { command: "abs-tool", timeout: 3000 });
		expect(result.passed).toBe(true);
		expect(result.output).toContain("abs-tool ok");
	});
});

describe("runCoverageGate", () => {
	it("skips when threshold is 0 (disabled)", () => {
		const result = runCoverageGate(
			"coverage",
			{ command: "echo 'coverage: 50.0% of statements'" },
			0,
		);
		expect(result.passed).toBe(true);
		expect(result.output).toContain("skipped");
	});

	it("passes when coverage meets threshold", () => {
		const result = runCoverageGate(
			"coverage",
			{ command: "echo 'coverage: 85.0% of statements'" },
			80,
		);
		expect(result.passed).toBe(true);
	});

	it("fails when coverage is below threshold", () => {
		const result = runCoverageGate(
			"coverage",
			{ command: "echo 'coverage: 75.0% of statements'" },
			80,
		);
		expect(result.passed).toBe(false);
		expect(result.output).toContain("75");
		expect(result.output).toContain("80");
	});

	it("passes when coverage output cannot be parsed (fail-open)", () => {
		const result = runCoverageGate("coverage", { command: "echo 'all tests passed'" }, 80);
		expect(result.passed).toBe(true);
	});

	it("fails when underlying gate command fails", () => {
		const result = runCoverageGate("coverage", { command: "exit 1" }, 80);
		expect(result.passed).toBe(false);
	});
});
