import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearPendingFixes,
	formatPendingFixes,
	hasPendingFixes,
	parseGateOutput,
	readPendingFixes,
	writePendingFixes,
} from "../pending-fixes.js";

describe("pending-fixes", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `alfred-test-${Date.now()}`);
		mkdirSync(join(tmpDir, ".alfred", ".state"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns empty when no fixes file", () => {
		const fixes = readPendingFixes(tmpDir);
		expect(fixes.files).toEqual({});
		expect(hasPendingFixes(tmpDir)).toBe(false);
	});

	it("writes and reads pending fixes", () => {
		const fixes = {
			files: {
				"src/foo.ts": {
					lint: [{ line: 10, rule: "no-unused-vars", message: "x is unused" }],
				},
			},
			updated_at: "2026-03-26T10:00:00Z",
		};

		writePendingFixes(tmpDir, fixes);
		expect(hasPendingFixes(tmpDir)).toBe(true);

		const read = readPendingFixes(tmpDir);
		expect(read.files["src/foo.ts"]!.lint!.length).toBe(1);
		expect(read.files["src/foo.ts"]!.lint![0]!.message).toBe("x is unused");
	});

	it("clears pending fixes", () => {
		writePendingFixes(tmpDir, {
			files: { "a.ts": { lint: [{ message: "err" }] } },
			updated_at: "2026-03-26T10:00:00Z",
		});
		expect(hasPendingFixes(tmpDir)).toBe(true);

		clearPendingFixes(tmpDir);
		expect(hasPendingFixes(tmpDir)).toBe(false);
	});
});

describe("formatPendingFixes", () => {
	it("formats lint and type errors", () => {
		const result = formatPendingFixes({
			files: {
				"src/foo.ts": {
					lint: [{ line: 10, rule: "no-unused-vars", message: "x is unused" }],
					type: [{ line: 20, message: "string not assignable to number" }],
				},
			},
			updated_at: "",
		});

		expect(result).toContain("src/foo.ts:10 (no-unused-vars): x is unused");
		expect(result).toContain("src/foo.ts:20: string not assignable to number");
	});

	it("formats entries without line numbers", () => {
		const result = formatPendingFixes({
			files: {
				"src/bar.ts": {
					lint: [{ message: "some error" }],
				},
			},
			updated_at: "",
		});

		expect(result).toContain("src/bar.ts: some error");
	});
});

describe("parseGateOutput", () => {
	it("parses standard lint output (file:line:col: message)", () => {
		const output = "src/foo.ts:15:3: Unexpected 'any' (no-explicit-any)";
		const entries = parseGateOutput(output, "lint");
		expect(entries.length).toBe(1);
		expect(entries[0]!.line).toBe(15);
		expect(entries[0]!.message).toContain("Unexpected");
	});

	it("parses tsc output (file(line,col): error TS...)", () => {
		const output =
			"src/foo.ts(22,5): error TS2322: Type 'string' is not assignable to type 'number'.";
		const entries = parseGateOutput(output, "typecheck");
		expect(entries.length).toBe(1);
		expect(entries[0]!.line).toBe(22);
		expect(entries[0]!.rule).toBe("typecheck");
	});

	it("returns empty for empty output", () => {
		expect(parseGateOutput("", "lint")).toEqual([]);
	});

	it("caps entries at 20", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `src/foo.ts:${i + 1}:1: Error ${i}`).join(
			"\n",
		);
		const entries = parseGateOutput(lines, "lint");
		expect(entries.length).toBe(20);
	});
});
