import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, setProjectPath, useTestDb } from "../../state/db.ts";
import { loadGates, resetGatesCache, saveGates } from "../load.ts";

const TEST_DIR = "/tmp/.tmp-load-test";

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	resetGatesCache();
});

afterEach(() => {
	closeDb();
});

describe("loadGates", () => {
	it("returns null when no gates exist", () => {
		const result = loadGates();
		expect(result).toBeNull();
	});

	it("returns parsed config from saved gates", () => {
		saveGates({
			on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
		});

		const result = loadGates();
		expect(result).not.toBeNull();
		expect(result?.on_write?.lint?.command).toBe("biome check {file}");
	});

	it("caches after first read", () => {
		saveGates({
			on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
		});

		const first = loadGates();
		// saveGates invalidates cache, but loadGates should cache the result
		const second = loadGates();

		expect(first).not.toBeNull();
		expect(second).toBe(first);
	});

	it("returns fresh data after resetGatesCache", () => {
		saveGates({ on_write: { lint: { command: "v1", timeout: 1000 } } });
		const first = loadGates();

		saveGates({ on_write: { lint: { command: "v2", timeout: 1000 } } });
		resetGatesCache();
		const second = loadGates();

		expect(first?.on_write?.lint?.command).toBe("v1");
		expect(second?.on_write?.lint?.command).toBe("v2");
	});
});
