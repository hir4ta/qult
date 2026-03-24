import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addWorkedSlug,
	ensureStateDir,
	readStateJSON,
	readWaveProgress,
	readWorkedSlugs,
	resetWorkedSlugs,
	stateDir,
	writeStateJSON,
	writeWaveProgress,
} from "../state.js";
import type { WaveProgress } from "../state.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "state-"));
	mkdirSync(join(tmpDir, ".alfred"), { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("stateDir", () => {
	it("returns .alfred/.state path", () => {
		expect(stateDir(tmpDir)).toBe(join(tmpDir, ".alfred", ".state"));
	});
});

describe("ensureStateDir", () => {
	it("creates directory if missing", () => {
		ensureStateDir(tmpDir);
		const { existsSync } = require("node:fs");
		expect(existsSync(stateDir(tmpDir))).toBe(true);
	});

	it("is idempotent", () => {
		ensureStateDir(tmpDir);
		ensureStateDir(tmpDir); // no throw
	});
});

describe("readStateJSON / writeStateJSON", () => {
	it("round-trips JSON data", () => {
		const data = { count: 3, label: "test" };
		writeStateJSON(tmpDir, "test.json", data);
		expect(readStateJSON(tmpDir, "test.json", {})).toEqual(data);
	});

	it("returns fallback when file missing", () => {
		expect(readStateJSON(tmpDir, "missing.json", { default: true })).toEqual({ default: true });
	});

	it("returns fallback on invalid JSON", () => {
		ensureStateDir(tmpDir);
		writeFileSync(join(stateDir(tmpDir), "bad.json"), "not json");
		expect(readStateJSON(tmpDir, "bad.json", [])).toEqual([]);
	});
});

describe("worked-slugs", () => {
	it("returns empty array when no file exists", () => {
		expect(readWorkedSlugs(tmpDir)).toEqual([]);
	});

	it("adds slugs with deduplication", () => {
		addWorkedSlug(tmpDir, "task-a");
		addWorkedSlug(tmpDir, "task-b");
		addWorkedSlug(tmpDir, "task-a"); // duplicate
		expect(readWorkedSlugs(tmpDir)).toEqual(["task-a", "task-b"]);
	});

	it("resets to empty array", () => {
		addWorkedSlug(tmpDir, "task-a");
		resetWorkedSlugs(tmpDir);
		expect(readWorkedSlugs(tmpDir)).toEqual([]);
	});
});

describe("wave progress persistence (TS-1.4)", () => {
	it("round-trips wave progress", () => {
		const progress: WaveProgress = {
			slug: "test-slug",
			current_wave: 2,
			waves: {
				"1": { total: 3, checked: 3, reviewed: true },
				"2": { total: 2, checked: 0, reviewed: false },
			},
		};
		writeWaveProgress(tmpDir, progress);
		const read = readWaveProgress(tmpDir);
		expect(read).toEqual(progress);
	});

	it("returns null when no file exists (TS-1.6)", () => {
		expect(readWaveProgress(tmpDir)).toBeNull();
	});
});
