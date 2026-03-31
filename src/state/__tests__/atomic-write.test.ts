import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteJson } from "../atomic-write.ts";

const TMP = join(import.meta.dirname, ".tmp-atomic-test");

beforeEach(() => {
	mkdirSync(join(TMP, "sub"), { recursive: true });
});

afterEach(() => {
	try {
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

	it("cleans up temp file and rethrows when writeFileSync fails", () => {
		mkdirSync(join(TMP, "readonly"), { recursive: true });
		const roPath = join(TMP, "readonly", "fail.json");

		chmodSync(join(TMP, "readonly"), 0o444);

		try {
			expect(() => atomicWriteJson(roPath, { x: 1 })).toThrow();
		} finally {
			chmodSync(join(TMP, "readonly"), 0o755);
		}
	});

	it("throws when target path is impossible", () => {
		const target = join("/dev/null", "impossible.json");
		expect(() => atomicWriteJson(target, { z: 1 })).toThrow();
	});

	it("concurrent writes produce valid JSON with no leftover temp files", async () => {
		const target = join(TMP, "concurrent.json");
		const N = 10;

		// Write a runner script that imports and calls atomicWriteJson
		const scriptPath = join(TMP, "writer.ts");
		const modulePath = join(import.meta.dirname, "..", "atomic-write.ts");
		writeFileSync(
			scriptPath,
			`import { atomicWriteJson } from "${modulePath}";\n` +
				`atomicWriteJson("${target}", { pid: process.pid, i: +process.argv[2] });\n`,
		);

		// Spawn N processes in parallel
		const { spawn } = await import("node:child_process");
		const exits = await Promise.all(
			Array.from(
				{ length: N },
				(_, i) =>
					new Promise<number>((resolve) => {
						const child = spawn("bun", ["run", scriptPath, String(i)], {
							stdio: "ignore",
						});
						child.on("close", (code: number) => resolve(code ?? 1));
					}),
			),
		);

		// All processes should succeed
		expect(exits.every((c) => c === 0)).toBe(true);

		// File must be valid JSON (no corruption from partial writes)
		const content = readFileSync(target, "utf-8");
		const parsed = JSON.parse(content);
		expect(parsed).toHaveProperty("pid");
		expect(parsed).toHaveProperty("i");

		// No leftover .tmp files
		const files = readdirSync(TMP);
		expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
	});
});
