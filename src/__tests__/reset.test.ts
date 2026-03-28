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
	writeFileSync(join(STATE_DIR, "session-state.json"), "{}");
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("qult reset", () => {
	it("deletes all state files and returns file names", () => {
		const result = runReset();
		expect(result.deleted).toHaveLength(2);
		expect(readdirSync(STATE_DIR)).toHaveLength(0);
	});

	it("handles missing .qult/.state gracefully", () => {
		rmSync(STATE_DIR, { recursive: true, force: true });
		const result = runReset();
		expect(result.deleted).toHaveLength(0);
	});

	it("dry-run shows files without deleting", () => {
		const result = runReset(true);
		expect(result.deleted).toHaveLength(2);
		expect(readdirSync(STATE_DIR)).toHaveLength(2);
	});
});
