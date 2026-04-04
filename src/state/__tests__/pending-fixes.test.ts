import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetAllCaches } from "../flush.ts";
import {
	addPendingFixes,
	clearPendingFixesForFile,
	flush as flushFixes,
	readPendingFixes,
	setFixesSessionScope,
	writePendingFixes,
} from "../pending-fixes.ts";

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

describe("addPendingFixes", () => {
	it("appends without dropping fixes for other files", () => {
		writePendingFixes([{ file: "a.ts", errors: ["err1"], gate: "lint" }]);

		addPendingFixes("b.ts", [{ file: "b.ts", errors: ["err2"], gate: "typecheck" }]);

		const result = readPendingFixes();
		expect(result).toHaveLength(2);
		expect(result.map((f) => f.file)).toContain("a.ts");
		expect(result.map((f) => f.file)).toContain("b.ts");
	});

	it("replaces fixes for the same file", () => {
		writePendingFixes([{ file: "a.ts", errors: ["old error"], gate: "lint" }]);

		addPendingFixes("a.ts", [{ file: "a.ts", errors: ["new error"], gate: "lint" }]);

		const result = readPendingFixes();
		expect(result).toHaveLength(1);
		expect(result[0]!.errors[0]).toBe("new error");
	});

	it("adds to empty state", () => {
		addPendingFixes("a.ts", [{ file: "a.ts", errors: ["err"], gate: "lint" }]);

		const result = readPendingFixes();
		expect(result).toHaveLength(1);
		expect(result[0]!.file).toBe("a.ts");
	});
});

describe("clearPendingFixesForFile", () => {
	it("removes only fixes for specified file", () => {
		writePendingFixes([
			{ file: "a.ts", errors: ["err1"], gate: "lint" },
			{ file: "b.ts", errors: ["err2"], gate: "typecheck" },
		]);

		clearPendingFixesForFile("a.ts");

		const result = readPendingFixes();
		expect(result).toHaveLength(1);
		expect(result[0]!.file).toBe("b.ts");
	});

	it("is a no-op for non-existent file", () => {
		writePendingFixes([{ file: "a.ts", errors: ["err1"], gate: "lint" }]);

		clearPendingFixesForFile("nonexistent.ts");

		const result = readPendingFixes();
		expect(result).toHaveLength(1);
	});
});

describe("session scope isolation", () => {
	it("writes and reads fixes independently per session scope", () => {
		// Session A: write fixes
		setFixesSessionScope("session-A");
		writePendingFixes([{ file: "a.ts", errors: ["err-A"], gate: "lint" }]);
		flushFixes();

		// Verify session A file exists
		const pathA = join(STATE_DIR, "pending-fixes-session-A.json");
		expect(existsSync(pathA)).toBe(true);
		const fixesA = JSON.parse(readFileSync(pathA, "utf-8"));
		expect(fixesA).toHaveLength(1);
		expect(fixesA[0].errors[0]).toBe("err-A");

		// Reset cache, switch to session B
		resetAllCaches();
		setFixesSessionScope("session-B");
		writePendingFixes([{ file: "b.ts", errors: ["err-B"], gate: "typecheck" }]);
		flushFixes();

		// Verify session B file exists and is independent
		const pathB = join(STATE_DIR, "pending-fixes-session-B.json");
		expect(existsSync(pathB)).toBe(true);
		const fixesB = JSON.parse(readFileSync(pathB, "utf-8"));
		expect(fixesB).toHaveLength(1);
		expect(fixesB[0].errors[0]).toBe("err-B");

		// Verify session A file is unchanged
		const fixesAAfter = JSON.parse(readFileSync(pathA, "utf-8"));
		expect(fixesAAfter).toHaveLength(1);
		expect(fixesAAfter[0].errors[0]).toBe("err-A");
	});

	it("reads correct session-scoped file after scope switch", () => {
		// Write to session A
		setFixesSessionScope("scope-1");
		writePendingFixes([{ file: "x.ts", errors: ["err-1"], gate: "lint" }]);
		flushFixes();

		// Switch to session B, write different data
		resetAllCaches();
		setFixesSessionScope("scope-2");
		writePendingFixes([
			{ file: "y.ts", errors: ["err-2a"], gate: "lint" },
			{ file: "z.ts", errors: ["err-2b"], gate: "typecheck" },
		]);
		flushFixes();

		// Switch back to session A, read
		resetAllCaches();
		setFixesSessionScope("scope-1");
		const result = readPendingFixes();
		expect(result).toHaveLength(1);
		expect(result[0]!.file).toBe("x.ts");
	});
});
