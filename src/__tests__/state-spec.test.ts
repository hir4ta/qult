import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProjectRoot } from "../state/paths.ts";
import {
	archiveSpec,
	getActiveSpec,
	gitHeadSha,
	isCommitReachable,
	isRangeReachable,
	listArchivedSpecs,
	listSpecNames,
	listWaveNumbers,
} from "../state/spec.ts";

let tmpRoot: string;

function mkSpec(name: string, files: string[] = []): void {
	const dir = join(tmpRoot, ".qult", "specs", name);
	mkdirSync(dir, { recursive: true });
	for (const f of files) writeFileSync(join(dir, f), "x");
}

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "qult-spec-"));
	mkdirSync(join(tmpRoot, ".qult", "specs"), { recursive: true });
	setProjectRoot(tmpRoot);
});

afterEach(() => {
	setProjectRoot(null);
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("listSpecNames", () => {
	it("returns empty when no specs", () => {
		expect(listSpecNames()).toEqual([]);
	});

	it("excludes archive/ directory", () => {
		mkdirSync(join(tmpRoot, ".qult", "specs", "archive"), { recursive: true });
		mkSpec("foo");
		expect(listSpecNames()).toEqual(["foo"]);
	});

	it("ignores invalid spec names", () => {
		mkSpec("foo");
		mkdirSync(join(tmpRoot, ".qult", "specs", "Bad-Name"), { recursive: true });
		expect(listSpecNames()).toEqual(["foo"]);
	});
});

describe("getActiveSpec", () => {
	it("returns null when no spec", () => {
		expect(getActiveSpec()).toBeNull();
	});

	it("returns the unique active spec", () => {
		mkSpec("foo", ["requirements.md", "design.md", "tasks.md"]);
		const info = getActiveSpec();
		expect(info?.name).toBe("foo");
		expect(info?.hasRequirements).toBe(true);
		expect(info?.hasDesign).toBe(true);
		expect(info?.hasTasks).toBe(true);
	});

	it("throws when multiple specs are present", () => {
		mkSpec("foo");
		mkSpec("bar");
		expect(() => getActiveSpec()).toThrow(/multiple active specs/);
	});
});

describe("archiveSpec", () => {
	it("moves spec dir under archive/", () => {
		mkSpec("foo", ["requirements.md"]);
		const dest = archiveSpec("foo");
		expect(existsSync(dest)).toBe(true);
		expect(existsSync(join(tmpRoot, ".qult", "specs", "foo"))).toBe(false);
		expect(listArchivedSpecs()).toEqual(["foo"]);
	});

	it("appends timestamp suffix on collision", () => {
		mkSpec("foo");
		archiveSpec("foo", new Date(Date.UTC(2026, 3, 25, 12, 0, 0)));
		mkSpec("foo");
		const dest = archiveSpec("foo", new Date(Date.UTC(2026, 3, 25, 13, 0, 0)));
		expect(dest).toMatch(/foo-20260425-130000$/);
	});

	it("rejects invalid spec names", () => {
		expect(() => archiveSpec("../etc")).toThrow(/invalid spec name/);
		expect(() => archiveSpec("archive")).toThrow(/reserved/);
	});

	it("throws when spec dir does not exist", () => {
		expect(() => archiveSpec("nope")).toThrow(/spec not found/);
	});
});

describe("listWaveNumbers", () => {
	it("returns wave nums in order", () => {
		mkSpec("foo");
		const wavesPath = join(tmpRoot, ".qult", "specs", "foo", "waves");
		mkdirSync(wavesPath, { recursive: true });
		writeFileSync(join(wavesPath, "wave-01.md"), "x");
		writeFileSync(join(wavesPath, "wave-03.md"), "x");
		writeFileSync(join(wavesPath, "wave-02.md"), "x");
		writeFileSync(join(wavesPath, "ignore.txt"), "x");
		expect(listWaveNumbers("foo")).toEqual([1, 2, 3]);
	});
});

describe("git helpers", () => {
	it("isCommitReachable returns false for malformed sha", () => {
		expect(isCommitReachable("zzz")).toBe(false);
		expect(isCommitReachable("")).toBe(false);
	});

	it("isRangeReachable rejects non-range strings", () => {
		expect(isRangeReachable("abc1234")).toBe(false);
	});

	it("operates on the current repo HEAD", () => {
		// We're inside the qult repo when tests run
		const head = gitHeadSha(process.cwd());
		expect(head).toMatch(/^[0-9a-f]{40}$/);
		expect(isCommitReachable(head, process.cwd())).toBe(true);
	});

	it("rejects an unreachable but well-formed sha", () => {
		// Generate a clearly bogus 40-char sha
		expect(isCommitReachable("0".repeat(40), process.cwd())).toBe(false);
	});
});

// Mark used to silence "import is unused" if execSync needed only for sanity:
void execSync;
