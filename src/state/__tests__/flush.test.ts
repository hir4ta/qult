import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushAll, resetAllCaches } from "../flush.ts";
import { readPendingFixes, writePendingFixes } from "../pending-fixes.ts";
import { readSessionState } from "../session-state.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-flush-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("cache behavior", () => {
	it("read returns cached value on second call without disk I/O", () => {
		const first = readSessionState();
		const second = readSessionState();
		expect(first).toBe(second); // same reference = cache hit
	});

	it("write updates cache without flushing to disk", () => {
		writePendingFixes([{ file: "a.ts", errors: ["err"], gate: "lint" }]);

		// Cache returns new value
		expect(readPendingFixes()).toHaveLength(1);
		// Disk is still empty (no flush yet)
		const diskPath = join(STATE_DIR, "pending-fixes.json");
		expect(existsSync(diskPath)).toBe(false);
	});

	it("flushAll writes dirty caches to disk", () => {
		writePendingFixes([{ file: "b.ts", errors: ["err2"], gate: "typecheck" }]);

		flushAll();

		const diskPath = join(STATE_DIR, "pending-fixes.json");
		expect(existsSync(diskPath)).toBe(true);
		const disk = JSON.parse(readFileSync(diskPath, "utf-8"));
		expect(disk).toHaveLength(1);
		expect(disk[0].file).toBe("b.ts");
	});

	it("flushAll skips clean caches (no unnecessary writes)", () => {
		// Only read, don't write — nothing should be flushed
		readSessionState();
		flushAll();

		const diskPath = join(STATE_DIR, "session-state.json");
		expect(existsSync(diskPath)).toBe(false);
	});

	it("resetAllCaches clears all module caches", () => {
		// Populate caches
		writePendingFixes([{ file: "c.ts", errors: ["e"], gate: "lint" }]);
		readSessionState();

		resetAllCaches();

		// After reset, readPendingFixes reads from disk (which is empty)
		expect(readPendingFixes()).toEqual([]);
	});
});
