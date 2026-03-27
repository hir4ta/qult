import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGate } from "../gates/runner.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-runner-test");
const originalCwd = process.cwd();

beforeEach(() => {
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
	});

	it("truncates output to 1000 chars", () => {
		// Generate long output
		const result = runGate("long-gate", {
			command: `printf '%0.s-' {1..2000}`,
			timeout: 3000,
		});
		expect(result.passed).toBe(true);
		expect(result.output.length).toBeLessThanOrEqual(1000);
	});
});
