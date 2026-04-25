import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite, readJson, readText, readTextIfExists, writeJson } from "../state/fs.ts";
import { setProjectRoot } from "../state/paths.ts";

let tmpRoot: string;
let qultRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "qult-fs-"));
	qultRoot = join(tmpRoot, ".qult");
	mkdirSync(qultRoot, { recursive: true });
	setProjectRoot(tmpRoot);
});

afterEach(() => {
	setProjectRoot(null);
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("atomicWrite", () => {
	it("writes content via tmp+rename and creates parent dirs", () => {
		const target = join(qultRoot, "specs", "foo", "tasks.md");
		atomicWrite(target, "hello");
		expect(readFileSync(target, "utf8")).toBe("hello");
		expect(existsSync(`${target}.tmp`)).toBe(false);
	});

	it("rejects writes outside .qult/", () => {
		expect(() => atomicWrite(join(tmpRoot, "outside.md"), "x")).toThrow(/path escape/);
	});

	it("overwrites existing files atomically", () => {
		const target = join(qultRoot, "config.json");
		atomicWrite(target, "first");
		atomicWrite(target, "second");
		expect(readFileSync(target, "utf8")).toBe("second");
	});
});

describe("readText / readTextIfExists", () => {
	it("returns null for missing files", () => {
		expect(readTextIfExists(join(qultRoot, "missing.json"))).toBeNull();
	});

	it("throws for missing files when using readText", () => {
		expect(() => readText(join(qultRoot, "missing.json"))).toThrow(/file not found/);
	});

	it("rejects oversized files", () => {
		const huge = "x".repeat(2 * 1024 * 1024);
		const target = join(qultRoot, "big.txt");
		writeFileSync(target, huge);
		expect(() => readText(target)).toThrow(/file too large/);
	});
});

describe("readJson / writeJson", () => {
	it("round-trips JSON with schema_version", () => {
		const target = join(qultRoot, "state", "current.json");
		writeJson(target, { schema_version: 1, foo: "bar" });
		const got = readJson<{ schema_version: number; foo: string }>(target, 1);
		expect(got).toEqual({ schema_version: 1, foo: "bar" });
	});

	it("returns null for missing file", () => {
		expect(readJson(join(qultRoot, "state", "missing.json"), 1)).toBeNull();
	});

	it("throws on schema_version mismatch", () => {
		const target = join(qultRoot, "state", "x.json");
		writeJson(target, { schema_version: 2, x: 1 });
		expect(() => readJson(target, 1)).toThrow(/schema_version mismatch/);
	});

	it("throws on malformed JSON", () => {
		const target = join(qultRoot, "state", "bad.json");
		mkdirSync(join(qultRoot, "state"), { recursive: true });
		writeFileSync(target, "{ not json");
		expect(() => readJson(target, 1)).toThrow(/malformed JSON/);
	});

	it("throws on missing schema_version field", () => {
		const target = join(qultRoot, "state", "noschema.json");
		mkdirSync(join(qultRoot, "state"), { recursive: true });
		writeFileSync(target, '{"foo":"bar"}');
		expect(() => readJson(target, 1)).toThrow(/schema_version/);
	});
});
