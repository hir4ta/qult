import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addWorkedSlug,
	ensureStateDir,
	readStateJSON,
	readStateText,
	readWorkedSlugs,
	resetWorkedSlugs,
	stateDir,
	writeStateJSON,
	writeStateText,
} from "../state.js";

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
		writeStateText(tmpDir, "bad.json", "not json");
		expect(readStateJSON(tmpDir, "bad.json", [])).toEqual([]);
	});
});

describe("readStateText / writeStateText", () => {
	it("round-trips text data", () => {
		writeStateText(tmpDir, "counter", "42");
		expect(readStateText(tmpDir, "counter", "0")).toBe("42");
	});

	it("returns fallback when file missing", () => {
		expect(readStateText(tmpDir, "missing", "default")).toBe("default");
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
