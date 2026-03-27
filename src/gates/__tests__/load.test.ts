import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGates } from "../load.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-load-test");
const QULT_DIR = join(TEST_DIR, ".qult");
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(QULT_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadGates", () => {
	it("returns null when gates.json does not exist", () => {
		const result = loadGates();
		expect(result).toBeNull();
	});

	it("returns parsed config from valid gates.json", () => {
		const gates = { on_write: { lint: { command: "biome check {file}", timeout: 3000 } } };
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));

		const result = loadGates();
		expect(result).not.toBeNull();
		expect(result?.on_write?.lint?.command).toBe("biome check {file}");
	});

	it("returns null on corrupted JSON (fail-open)", () => {
		writeFileSync(join(QULT_DIR, "gates.json"), "not valid json{{{");

		const result = loadGates();
		expect(result).toBeNull();
	});
});
