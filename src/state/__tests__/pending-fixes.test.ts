import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, ensureSession, setProjectPath, setSessionScope, useTestDb } from "../db.ts";
import {
	addPendingFixes,
	clearPendingFixesForFile,
	flush as flushFixes,
	readPendingFixes,
	resetCache,
	writePendingFixes,
} from "../pending-fixes.ts";

beforeEach(() => {
	useTestDb();
	setProjectPath("/tmp/test");
	setSessionScope("test-session");
	ensureSession();
	resetCache();
});

afterEach(() => {
	closeDb();
});

describe("readPendingFixes", () => {
	it("returns empty array when no file exists", () => {
		const result = readPendingFixes();
		expect(result).toEqual([]);
		expect(Array.isArray(result)).toBe(true);
	});

	it("reads valid pending fixes from DB", () => {
		const fixes = [{ file: "src/foo.ts", errors: ["error TS2345"], gate: "typecheck" }];
		writePendingFixes(fixes);
		flushFixes();
		resetCache();

		const result = readPendingFixes();
		expect(result).toHaveLength(1);
		expect(result[0]!.file).toBe("src/foo.ts");
	});
});

describe("writePendingFixes", () => {
	it("writes fixes to DB", () => {
		const fixes = [{ file: "src/bar.ts", errors: ["unused import"], gate: "lint" }];
		writePendingFixes(fixes);
		flushFixes();
		resetCache();

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
		flushFixes();
		resetCache();

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
		setSessionScope("session-A");
		ensureSession();
		resetCache();
		writePendingFixes([{ file: "a.ts", errors: ["err-A"], gate: "lint" }]);
		flushFixes();

		// Switch to session B
		resetCache();
		setSessionScope("session-B");
		ensureSession();
		writePendingFixes([{ file: "b.ts", errors: ["err-B"], gate: "typecheck" }]);
		flushFixes();

		// Verify session B
		resetCache();
		const fixesB = readPendingFixes();
		expect(fixesB).toHaveLength(1);
		expect(fixesB[0]!.errors[0]).toBe("err-B");

		// Switch back to session A, verify independent
		resetCache();
		setSessionScope("session-A");
		const fixesA = readPendingFixes();
		expect(fixesA).toHaveLength(1);
		expect(fixesA[0]!.errors[0]).toBe("err-A");
	});

	it("reads correct session-scoped data after scope switch", () => {
		// Write to session 1
		setSessionScope("scope-1");
		ensureSession();
		resetCache();
		writePendingFixes([{ file: "x.ts", errors: ["err-1"], gate: "lint" }]);
		flushFixes();

		// Switch to session 2, write different data
		resetCache();
		setSessionScope("scope-2");
		ensureSession();
		writePendingFixes([
			{ file: "y.ts", errors: ["err-2a"], gate: "lint" },
			{ file: "z.ts", errors: ["err-2b"], gate: "typecheck" },
		]);
		flushFixes();

		// Switch back to session 1, read
		resetCache();
		setSessionScope("scope-1");
		const result = readPendingFixes();
		expect(result).toHaveLength(1);
		expect(result[0]!.file).toBe("x.ts");
	});
});
