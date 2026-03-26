import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectGates } from "../detect.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-detect-test");

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("detectGates", () => {
	it("detects biome + tsc + vitest from project files", () => {
		writeFileSync(join(TEST_DIR, "biome.json"), "{}");
		writeFileSync(join(TEST_DIR, "tsconfig.json"), "{}");
		writeFileSync(
			join(TEST_DIR, "package.json"),
			JSON.stringify({ devDependencies: { vitest: "^3" } }),
		);

		const gates = detectGates(TEST_DIR);

		expect(gates.on_write?.lint?.command).toContain("biome check");
		expect(gates.on_write?.typecheck?.command).toContain("tsc --noEmit");
		expect(gates.on_commit?.test?.command).toContain("vitest");
	});

	it("detects eslint when no biome", () => {
		writeFileSync(join(TEST_DIR, "eslint.config.js"), "");

		const gates = detectGates(TEST_DIR);

		expect(gates.on_write?.lint?.command).toContain("eslint");
		expect(gates.on_write?.typecheck).toBeUndefined();
	});

	it("returns empty gates for empty project", () => {
		const gates = detectGates(TEST_DIR);

		expect(Object.keys(gates.on_write ?? {})).toHaveLength(0);
		expect(Object.keys(gates.on_commit ?? {})).toHaveLength(0);
	});

	it("detects Go project", () => {
		writeFileSync(join(TEST_DIR, "go.mod"), "module example.com/foo");

		const gates = detectGates(TEST_DIR);

		expect(gates.on_commit?.test?.command).toContain("go test");
	});
});
