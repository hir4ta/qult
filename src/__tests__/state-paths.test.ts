import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	archiveDir,
	assertConfinedToQult,
	assertValidSpecName,
	assertValidWaveNum,
	configJsonPath,
	currentJsonPath,
	designPath,
	formatWaveNum,
	gitignorePath,
	isValidSpecName,
	pendingFixesJsonPath,
	qultDir,
	requirementsPath,
	setProjectRoot,
	specDir,
	stageScoresJsonPath,
	stateDir,
	tasksPath,
	WAVE_NUM_MAX,
	WAVE_NUM_MIN,
	wavePath,
	wavesDir,
} from "../state/paths.ts";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "qult-paths-"));
	mkdirSync(join(tmpRoot, ".qult"), { recursive: true });
	setProjectRoot(tmpRoot);
});

afterEach(() => {
	setProjectRoot(null);
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("paths construction", () => {
	it("returns absolute paths under project root", () => {
		expect(qultDir()).toBe(join(tmpRoot, ".qult"));
		expect(stateDir()).toBe(join(tmpRoot, ".qult", "state"));
		expect(archiveDir()).toBe(join(tmpRoot, ".qult", "specs", "archive"));
		expect(configJsonPath()).toBe(join(tmpRoot, ".qult", "config.json"));
		expect(gitignorePath()).toBe(join(tmpRoot, ".gitignore"));
	});

	it("constructs spec-scoped paths", () => {
		expect(specDir("foo")).toBe(join(tmpRoot, ".qult", "specs", "foo"));
		expect(requirementsPath("foo")).toBe(join(tmpRoot, ".qult", "specs", "foo", "requirements.md"));
		expect(designPath("foo")).toBe(join(tmpRoot, ".qult", "specs", "foo", "design.md"));
		expect(tasksPath("foo")).toBe(join(tmpRoot, ".qult", "specs", "foo", "tasks.md"));
		expect(wavesDir("foo")).toBe(join(tmpRoot, ".qult", "specs", "foo", "waves"));
		expect(wavePath("foo", 3)).toBe(join(tmpRoot, ".qult", "specs", "foo", "waves", "wave-03.md"));
	});

	it("returns absolute state json paths", () => {
		expect(currentJsonPath()).toBe(join(tmpRoot, ".qult", "state", "current.json"));
		expect(pendingFixesJsonPath()).toBe(join(tmpRoot, ".qult", "state", "pending-fixes.json"));
		expect(stageScoresJsonPath()).toBe(join(tmpRoot, ".qult", "state", "stage-scores.json"));
	});
});

describe("formatWaveNum", () => {
	it("zero-pads to 2 digits", () => {
		expect(formatWaveNum(1)).toBe("01");
		expect(formatWaveNum(9)).toBe("09");
		expect(formatWaveNum(10)).toBe("10");
		expect(formatWaveNum(99)).toBe("99");
	});

	it("rejects out-of-range numbers", () => {
		expect(() => formatWaveNum(0)).toThrow();
		expect(() => formatWaveNum(100)).toThrow();
		expect(() => formatWaveNum(-1)).toThrow();
		expect(() => formatWaveNum(1.5)).toThrow();
	});
});

describe("assertValidWaveNum", () => {
	it("accepts integers in [1, 99]", () => {
		expect(() => assertValidWaveNum(WAVE_NUM_MIN)).not.toThrow();
		expect(() => assertValidWaveNum(WAVE_NUM_MAX)).not.toThrow();
		expect(() => assertValidWaveNum(50)).not.toThrow();
	});

	it("rejects non-integer / out-of-range", () => {
		expect(() => assertValidWaveNum(0)).toThrow();
		expect(() => assertValidWaveNum(100)).toThrow();
		expect(() => assertValidWaveNum(1.5)).toThrow();
	});
});

describe("spec name validation", () => {
	it("accepts kebab-case names", () => {
		expect(isValidSpecName("foo")).toBe(true);
		expect(isValidSpecName("add-oauth")).toBe(true);
		expect(isValidSpecName("v1-rewrite")).toBe(true);
		expect(isValidSpecName("a")).toBe(true);
		expect(isValidSpecName("a".repeat(64))).toBe(true);
	});

	it("rejects invalid names", () => {
		expect(isValidSpecName("")).toBe(false);
		expect(isValidSpecName("Foo")).toBe(false); // uppercase
		expect(isValidSpecName("-foo")).toBe(false); // leading hyphen
		expect(isValidSpecName(".hidden")).toBe(false);
		expect(isValidSpecName("foo/bar")).toBe(false);
		expect(isValidSpecName("foo\\bar")).toBe(false);
		expect(isValidSpecName("a".repeat(65))).toBe(false);
	});

	it("rejects reserved name 'archive'", () => {
		expect(isValidSpecName("archive")).toBe(false);
		expect(() => assertValidSpecName("archive")).toThrow(/reserved/);
	});
});

describe("assertConfinedToQult", () => {
	it("accepts paths under .qult/", () => {
		expect(() => assertConfinedToQult(join(tmpRoot, ".qult", "x.md"))).not.toThrow();
		expect(() =>
			assertConfinedToQult(join(tmpRoot, ".qult", "specs", "foo", "tasks.md")),
		).not.toThrow();
	});

	it("rejects paths outside .qult/", () => {
		expect(() => assertConfinedToQult(join(tmpRoot, "other.md"))).toThrow(/path escape/);
		expect(() => assertConfinedToQult("/etc/passwd")).toThrow(/path escape/);
		expect(() => assertConfinedToQult(join(tmpRoot, ".qultx", "trick"))).toThrow(/path escape/);
	});
});
