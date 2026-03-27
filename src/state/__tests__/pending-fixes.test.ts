import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAllCaches } from "../flush.ts";
import { readPendingFixes, writePendingFixes } from "../pending-fixes.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-pf-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("readPendingFixes", () => {
	it("returns empty array when no file exists", () => {
		const result = readPendingFixes();
		expect(result).toEqual([]);
		expect(Array.isArray(result)).toBe(true);
	});

	it("reads valid pending fixes from file", () => {
		const fixes = [{ file: "src/foo.ts", errors: ["error TS2345"], gate: "typecheck" }];
		writeFileSync(join(STATE_DIR, "pending-fixes.json"), JSON.stringify(fixes));

		const result = readPendingFixes();
		expect(result).toHaveLength(1);
		expect(result[0]!.file).toBe("src/foo.ts");
	});

	it("returns empty array on corrupted JSON (fail-open)", () => {
		writeFileSync(join(STATE_DIR, "pending-fixes.json"), "not json{{{");

		const result = readPendingFixes();
		expect(result).toEqual([]);
		expect(Array.isArray(result)).toBe(true);
	});
});

describe("writePendingFixes", () => {
	it("creates state directory and writes fixes", () => {
		rmSync(STATE_DIR, { recursive: true, force: true });

		const fixes = [{ file: "src/bar.ts", errors: ["unused import"], gate: "lint" }];
		writePendingFixes(fixes);

		const result = readPendingFixes();
		expect(result).toHaveLength(1);
		expect(result[0]!.gate).toBe("lint");
	});

	it("replaces entire content on each write (caller manages merge)", () => {
		writePendingFixes([{ file: "a.ts", errors: ["err1"], gate: "lint" }]);
		writePendingFixes([
			{ file: "a.ts", errors: ["err1"], gate: "lint" },
			{ file: "b.ts", errors: ["err2"], gate: "typecheck" },
		]);

		const result = readPendingFixes();
		expect(result).toHaveLength(2);
		expect(result.map((f) => f.file)).toContain("a.ts");
		expect(result.map((f) => f.file)).toContain("b.ts");
	});
});
