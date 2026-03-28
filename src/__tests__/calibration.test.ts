import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-calibration-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("calibrate: pace_files adjustment", () => {
	it("increases pace_files when first-pass rate > 80%", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({
			firstPassRate: 85,
			firstPassTotal: 25,
			reviewMiss: 0,
			reviewTotal: 10,
			respondSkipped: 0,
			respond: 10,
			avgFixEffort: 1.0,
			fixEffortTotal: 5,
		});
		expect(cal.pace_files).toBe(20);
	});

	it("decreases pace_files when first-pass rate < 50%", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({
			firstPassRate: 40,
			firstPassTotal: 15,
			reviewMiss: 0,
			reviewTotal: 10,
			respondSkipped: 0,
			respond: 10,
			avgFixEffort: 2.0,
			fixEffortTotal: 5,
		});
		expect(cal.pace_files).toBe(10);
	});

	it("keeps default pace_files when insufficient data", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({
			firstPassRate: 90,
			firstPassTotal: 5,
			reviewMiss: 0,
			reviewTotal: 2,
			respondSkipped: 0,
			respond: 10,
			avgFixEffort: 1.0,
			fixEffortTotal: 2,
		});
		expect(cal.pace_files).toBe(15);
	});
});

describe("calibrate: review_file_threshold adjustment", () => {
	it("tightens review threshold when miss rate > 5%", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({
			firstPassRate: 70,
			firstPassTotal: 20,
			reviewMiss: 2,
			reviewTotal: 10,
			respondSkipped: 0,
			respond: 10,
			avgFixEffort: 1.5,
			fixEffortTotal: 5,
		});
		// 2/10 = 20% > 5% → tighten to 3
		expect(cal.review_file_threshold).toBe(3);
	});

	it("keeps default when miss rate <= 5%", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({
			firstPassRate: 70,
			firstPassTotal: 20,
			reviewMiss: 1,
			reviewTotal: 50,
			respondSkipped: 0,
			respond: 10,
			avgFixEffort: 1.5,
			fixEffortTotal: 5,
		});
		// 1/50 = 2% <= 5% → keep default 5
		expect(cal.review_file_threshold).toBe(5);
	});

	it("keeps default when insufficient review data", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({
			firstPassRate: 70,
			firstPassTotal: 20,
			reviewMiss: 1,
			reviewTotal: 3,
			respondSkipped: 0,
			respond: 10,
			avgFixEffort: 1.5,
			fixEffortTotal: 5,
		});
		// reviewTotal < 5 → keep default
		expect(cal.review_file_threshold).toBe(5);
	});
});

describe("calibrate: context_budget adjustment", () => {
	it("increases budget when respond-skipped rate > 20%", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({
			firstPassRate: 70,
			firstPassTotal: 20,
			reviewMiss: 0,
			reviewTotal: 10,
			respondSkipped: 5,
			respond: 10,
			avgFixEffort: 1.5,
			fixEffortTotal: 5,
		});
		expect(cal.context_budget).toBe(2500);
	});

	it("decreases budget when respond-skipped rate < 5%", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({
			firstPassRate: 70,
			firstPassTotal: 20,
			reviewMiss: 0,
			reviewTotal: 10,
			respondSkipped: 0,
			respond: 50,
			avgFixEffort: 1.5,
			fixEffortTotal: 5,
		});
		expect(cal.context_budget).toBe(1500);
	});
});

describe("calibrate: loc_limit adjustment", () => {
	it("tightens LOC limit when avg fix effort > 3", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({
			firstPassRate: 70,
			firstPassTotal: 20,
			reviewMiss: 0,
			reviewTotal: 10,
			respondSkipped: 0,
			respond: 10,
			avgFixEffort: 3.5,
			fixEffortTotal: 10,
		});
		expect(cal.loc_limit).toBe(150);
	});

	it("relaxes LOC limit when avg fix effort < 1.5", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({
			firstPassRate: 85,
			firstPassTotal: 25,
			reviewMiss: 0,
			reviewTotal: 10,
			respondSkipped: 0,
			respond: 10,
			avgFixEffort: 1.0,
			fixEffortTotal: 8,
		});
		expect(cal.loc_limit).toBe(250);
	});
});

describe("readCalibration and writeCalibration", () => {
	it("returns null when no calibration file", async () => {
		const { readCalibration } = await import("../state/calibration.ts");
		expect(readCalibration()).toBeNull();
	});

	it("reads and writes calibration", async () => {
		const { readCalibration, writeCalibration } = await import("../state/calibration.ts");
		const cal = {
			pace_files: 20,
			review_file_threshold: 3,
			context_budget: 2500,
			loc_limit: 150,
			calibrated_at: "2026-03-28T00:00:00Z",
		};
		writeCalibration(cal);
		const read = readCalibration();
		expect(read).not.toBeNull();
		expect(read!.pace_files).toBe(20);
		expect(read!.loc_limit).toBe(150);
	});
});

describe("shouldRecalibrate", () => {
	it("returns true when no calibration exists", async () => {
		const { shouldRecalibrate } = await import("../state/calibration.ts");
		expect(shouldRecalibrate()).toBe(true);
	});

	it("returns false when calibrated recently", async () => {
		const { shouldRecalibrate, writeCalibration } = await import("../state/calibration.ts");
		writeCalibration({
			pace_files: 15,
			review_file_threshold: 5,
			context_budget: 2000,
			loc_limit: 200,
			calibrated_at: new Date().toISOString(),
		});
		expect(shouldRecalibrate()).toBe(false);
	});

	it("returns true when calibrated > 24h ago", async () => {
		const { shouldRecalibrate, writeCalibration } = await import("../state/calibration.ts");
		writeCalibration({
			pace_files: 15,
			review_file_threshold: 5,
			context_budget: 2000,
			loc_limit: 200,
			calibrated_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
		});
		expect(shouldRecalibrate()).toBe(true);
	});
});

describe("getCalibrated", () => {
	it("returns calibrated value when available", async () => {
		const { getCalibrated, writeCalibration } = await import("../state/calibration.ts");
		writeCalibration({
			pace_files: 20,
			review_file_threshold: 3,
			context_budget: 2500,
			loc_limit: 150,
			calibrated_at: new Date().toISOString(),
		});
		expect(getCalibrated("pace_files", 15)).toBe(20);
		expect(getCalibrated("loc_limit", 200)).toBe(150);
	});

	it("returns fallback when no calibration", async () => {
		const { getCalibrated } = await import("../state/calibration.ts");
		expect(getCalibrated("pace_files", 15)).toBe(15);
		expect(getCalibrated("context_budget", 2000)).toBe(2000);
	});
});
