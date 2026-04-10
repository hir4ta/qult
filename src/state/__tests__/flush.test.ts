import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, getProjectId, setProjectPath, useTestDb } from "../db.ts";
import { flushAll, resetAllCaches } from "../flush.ts";
import { readPendingFixes, writePendingFixes } from "../pending-fixes.ts";
import {
	disableGate,
	enableGate,
	flush as flushSessionState,
	readSessionState,
	resetCache as resetSessionStateCache,
} from "../session-state.ts";

const TEST_DIR = "/tmp/.tmp-flush-test";

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	resetAllCaches();
});

afterEach(() => {
	closeDb();
});

describe("cache behavior", () => {
	it("read returns cached value on second call without DB I/O", () => {
		const first = readSessionState();
		const second = readSessionState();
		expect(first).toBe(second); // same reference = cache hit
	});

	it("write updates cache without flushing to DB", () => {
		writePendingFixes([{ file: "a.ts", errors: ["err"], gate: "lint" }]);

		// Cache returns new value
		expect(readPendingFixes()).toHaveLength(1);
		// DB is still empty (no flush yet)
		const db = getDb();
		const rows = db.prepare("SELECT * FROM pending_fixes WHERE project_id = ?").all(getProjectId());
		expect(rows).toHaveLength(0);
	});

	it("flushAll writes dirty caches to DB", () => {
		writePendingFixes([{ file: "b.ts", errors: ["err2"], gate: "typecheck" }]);

		flushAll();

		const db = getDb();
		const rows = db
			.prepare("SELECT file, gate FROM pending_fixes WHERE project_id = ?")
			.all(getProjectId()) as { file: string; gate: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.file).toBe("b.ts");
	});

	it("flushAll skips clean caches (no unnecessary writes)", () => {
		// Only read, don't write — nothing should be flushed
		readSessionState();
		flushAll();

		const db = getDb();
		const rows = db.prepare("SELECT * FROM pending_fixes WHERE project_id = ?").all(getProjectId());
		expect(rows).toHaveLength(0);
	});

	it("resetAllCaches clears all module caches", () => {
		// Populate caches
		writePendingFixes([{ file: "c.ts", errors: ["e"], gate: "lint" }]);
		readSessionState();

		resetAllCaches();

		// After reset, readPendingFixes reads from DB (which is empty since we didn't flush)
		expect(readPendingFixes()).toEqual([]);
	});
});

describe("_dirty flag on flush failure", () => {
	it("remains dirty when flush throws (so next flush can retry)", () => {
		// Mark state dirty
		disableGate("lint");

		// Break the DB connection so flush() will fail
		const db = getDb();
		db.close();

		// flush() must not throw (fail-open)
		expect(() => flushSessionState()).not.toThrow();

		// Re-open a fresh in-memory DB
		useTestDb();
		setProjectPath(TEST_DIR);

		// The second flush should succeed and persist the gate,
		// because _dirty remained true after the first failure
		flushSessionState();

		const db2 = getDb();
		const rows = db2
			.prepare("SELECT gate_name FROM disabled_gates WHERE project_id = ?")
			.all(getProjectId()) as { gate_name: string }[];
		expect(rows.map((r) => r.gate_name)).toContain("lint");
	});
});

describe("disabled_gates merge on flush", () => {
	it("does not clobber MCP-added gates when in-memory set is empty", () => {
		const db = getDb();

		// Simulate MCP writing a gate directly to DB (bypassing in-memory cache)
		db.prepare(
			"INSERT OR REPLACE INTO disabled_gates (project_id, gate_name, reason) VALUES (?, ?, ?)",
		).run(getProjectId(), "lint", "disabled via MCP");

		// In-memory cache has a different gate added, doesn't know about "lint"
		disableGate("typecheck");
		flushSessionState();

		// "lint" written by MCP should still be present
		const rows = db
			.prepare("SELECT gate_name FROM disabled_gates WHERE project_id = ?")
			.all(getProjectId()) as { gate_name: string }[];
		const names = rows.map((r) => r.gate_name).sort();
		expect(names).toContain("lint");
		expect(names).toContain("typecheck");
	});

	it("removes re-enabled gate from DB even if MCP had written it", () => {
		const db = getDb();

		// Gate starts disabled in DB
		db.prepare(
			"INSERT OR REPLACE INTO disabled_gates (project_id, gate_name, reason) VALUES (?, ?, ?)",
		).run(getProjectId(), "lint", "old reason");

		// Process reads state and re-enables lint
		disableGate("lint"); // load into cache first
		resetSessionStateCache();
		// Re-read from DB so cache knows about "lint"
		readSessionState();
		enableGate("lint"); // removes from cache
		flushSessionState();

		const rows = db
			.prepare("SELECT gate_name FROM disabled_gates WHERE project_id = ?")
			.all(getProjectId()) as { gate_name: string }[];
		expect(rows.map((r) => r.gate_name)).not.toContain("lint");
	});
});
