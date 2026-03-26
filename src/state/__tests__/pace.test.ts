import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPaceRed, readPace, writePace } from "../pace.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-pace-test");
const STATE_DIR = join(TEST_DIR, ".alfred", ".state");

beforeEach(() => {
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("readPace / writePace", () => {
	it("returns null when no file exists", () => {
		expect(readPace()).toBeNull();
	});

	it("round-trips pace state", () => {
		const state = {
			last_commit_at: new Date().toISOString(),
			changed_files: 3,
			tool_calls: 10,
		};
		writePace(state);

		const result = readPace();
		expect(result).not.toBeNull();
		expect(result!.changed_files).toBe(3);
		expect(result!.tool_calls).toBe(10);
	});
});

describe("isPaceRed", () => {
	it("returns false for null state", () => {
		expect(isPaceRed(null)).toBe(false);
	});

	it("returns false for recent commit with few files", () => {
		const state = {
			last_commit_at: new Date().toISOString(),
			changed_files: 2,
			tool_calls: 5,
		};
		expect(isPaceRed(state)).toBe(false);
	});

	it("returns true for 35+ min without commit on 5+ files", () => {
		const oldTime = new Date(Date.now() - 40 * 60_000).toISOString();
		const state = {
			last_commit_at: oldTime,
			changed_files: 8,
			tool_calls: 50,
		};
		expect(isPaceRed(state)).toBe(true);
	});

	it("returns false for 35+ min but few files", () => {
		const oldTime = new Date(Date.now() - 40 * 60_000).toISOString();
		const state = {
			last_commit_at: oldTime,
			changed_files: 2,
			tool_calls: 50,
		};
		expect(isPaceRed(state)).toBe(false);
	});
});
