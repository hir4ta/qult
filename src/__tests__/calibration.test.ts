import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCalibration, readCalibration, recordCalibration } from "../state/calibration.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-calibration-test");
const PLUGIN_DATA = join(TEST_DIR, "plugin-data");

beforeEach(() => {
	mkdirSync(PLUGIN_DATA, { recursive: true });
	vi.stubEnv("CLAUDE_PLUGIN_DATA", PLUGIN_DATA);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("recordCalibration", () => {
	it("records and reads calibration data", () => {
		recordCalibration(28, { Spec: { completeness: 5, accuracy: 4 } });
		const data = readCalibration();
		expect(data).not.toBeNull();
		expect(data!.entries.length).toBe(1);
		expect(data!.entries[0]!.aggregate).toBe(28);
		expect(data!.stats.count).toBe(1);
		expect(data!.stats.mean).toBe(28);
	});

	it("accumulates multiple entries", () => {
		recordCalibration(26, {});
		recordCalibration(28, {});
		recordCalibration(30, {});
		const data = readCalibration();
		expect(data!.entries.length).toBe(3);
		expect(data!.stats.count).toBe(3);
		expect(data!.stats.mean).toBe(28);
	});

	it("trims to max entries", () => {
		for (let i = 0; i < 55; i++) {
			recordCalibration(28, {});
		}
		const data = readCalibration();
		expect(data!.entries.length).toBe(50);
	});
});

describe("checkCalibration", () => {
	it("returns empty warnings with insufficient data", () => {
		recordCalibration(28, {});
		expect(checkCalibration()).toEqual([]);
	});

	it("warns on high mean + low variance", () => {
		for (let i = 0; i < 6; i++) {
			recordCalibration(29, {});
		}
		const warnings = checkCalibration();
		expect(warnings.some((w) => w.type === "high_mean")).toBe(true);
	});

	it("warns on perfect score streak", () => {
		// Need 5 entries minimum
		recordCalibration(26, {});
		recordCalibration(26, {});
		recordCalibration(30, {});
		recordCalibration(30, {});
		recordCalibration(30, {});
		const warnings = checkCalibration();
		expect(warnings.some((w) => w.type === "perfect_streak")).toBe(true);
	});

	it("no warnings on well-distributed scores", () => {
		recordCalibration(22, {});
		recordCalibration(25, {});
		recordCalibration(28, {});
		recordCalibration(24, {});
		recordCalibration(27, {});
		const warnings = checkCalibration();
		expect(warnings.length).toBe(0);
	});
});

describe("readCalibration", () => {
	it("returns null when no data exists", () => {
		expect(readCalibration()).toBeNull();
	});

	it("returns null when CLAUDE_PLUGIN_DATA not set", () => {
		vi.stubEnv("CLAUDE_PLUGIN_DATA", "");
		expect(readCalibration()).toBeNull();
	});
});
