import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReset } from "../reset.ts";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-reset-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(join(STATE_DIR, "pending-fixes.json"), "[]");
	writeFileSync(join(STATE_DIR, "gate-history.json"), '{"gates":[],"commits":[]}');
	writeFileSync(join(STATE_DIR, "metrics.json"), "[]");
	writeFileSync(join(STATE_DIR, "fail-count.json"), '{"signature":"","count":0}');
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("qult reset", () => {
	it("deletes all state files and returns file names", () => {
		const result = runReset(false);
		expect(result.deleted).toHaveLength(4);
		expect(result.kept).toHaveLength(0);
		expect(readdirSync(STATE_DIR)).toHaveLength(0);
	});

	it("keeps gate-history and metrics with --keep-history", () => {
		const result = runReset(true);
		expect(result.deleted).toHaveLength(2);
		expect(result.kept).toHaveLength(2);
		expect(result.kept).toContain("gate-history.json");
		expect(result.kept).toContain("metrics.json");
		const remaining = readdirSync(STATE_DIR);
		expect(remaining).toContain("gate-history.json");
		expect(remaining).not.toContain("pending-fixes.json");
	});

	it("handles missing .qult/.state gracefully", () => {
		rmSync(STATE_DIR, { recursive: true, force: true });
		const result = runReset(false);
		expect(result.deleted).toHaveLength(0);
	});

	it("dry-run shows files without deleting", () => {
		const result = runReset(false, true);
		expect(result.deleted).toHaveLength(4);
		// Files should still exist after dry-run
		expect(readdirSync(STATE_DIR)).toHaveLength(4);
	});
});
