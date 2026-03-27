import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteJson } from "../atomic-write.ts";

const TMP = join(import.meta.dirname, ".tmp-atomic-test");

beforeEach(() => {
	mkdirSync(join(TMP, "sub"), { recursive: true });
});

afterEach(() => {
	try {
		const { rmSync } = require("node:fs");
		rmSync(TMP, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("atomicWriteJson", () => {
	it("writes valid JSON file", () => {
		const path = join(TMP, "test.json");
		atomicWriteJson(path, { foo: 1 });
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ foo: 1 });
	});

	it("creates parent directories if missing", () => {
		const path = join(TMP, "deep", "nested", "test.json");
		atomicWriteJson(path, [1, 2, 3]);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual([1, 2, 3]);
	});

	it("leaves no temp files after successful write", () => {
		const path = join(TMP, "clean.json");
		atomicWriteJson(path, { clean: true });
		const files = readdirSync(TMP);
		expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
	});

	it("overwrites existing file atomically", () => {
		const path = join(TMP, "overwrite.json");
		atomicWriteJson(path, { v: 1 });
		atomicWriteJson(path, { v: 2 });
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ v: 2 });
	});
});
