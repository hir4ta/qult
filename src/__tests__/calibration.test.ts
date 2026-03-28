import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-calibration-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
const originalCwd = process.cwd();

const BASE_INPUT = {
	firstPassRate: 65,
	firstPassTotal: 20,
	reviewMiss: 0,
	reviewTotal: 10,
	respondSkipped: 2,
	respond: 20,
	avgFixEffort: 2.0,
	fixEffortTotal: 5,
	planAvgCompliance: 70,
	planComplianceTotal: 0,
};

beforeEach(() => {
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("lerp", () => {
	it("interpolates linearly between min and max", async () => {
		const { lerp } = await import("../state/calibration.ts");
		expect(lerp(40, 40, 90, 10, 25)).toBe(10);
		expect(lerp(90, 40, 90, 10, 25)).toBe(25);
		expect(lerp(65, 40, 90, 10, 25)).toBe(18);
		expect(lerp(30, 40, 90, 10, 25)).toBe(10); // below low → min
		expect(lerp(100, 40, 90, 10, 25)).toBe(25); // above high → max
	});
});

describe("calibrate: pace_files graduated adjustment", () => {
	it("high first-pass rate → high pace_files", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, firstPassRate: 90 });
		expect(cal.pace_files).toBe(25);
	});

	it("low first-pass rate → low pace_files", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, firstPassRate: 40 });
		expect(cal.pace_files).toBe(10);
	});

	it("middle first-pass rate → interpolated pace_files", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, firstPassRate: 65 });
		expect(cal.pace_files).toBe(18);
	});

	it("cold start uses heuristic defaults", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, firstPassTotal: 5 });
		expect(cal.pace_files).toBe(15); // default (no gates.json)
	});
});

describe("calibrate: review_file_threshold graduated adjustment", () => {
	it("high miss rate → tighter review threshold", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, reviewMiss: 1, reviewTotal: 10 });
		// 1/10 = 10% → lerp(10, 0, 10, 7, 3) = 3
		expect(cal.review_file_threshold).toBe(3);
	});

	it("zero miss rate → relaxed review threshold", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, reviewMiss: 0, reviewTotal: 50 });
		expect(cal.review_file_threshold).toBe(7);
	});

	it("insufficient review data → default", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, reviewTotal: 3 });
		expect(cal.review_file_threshold).toBe(5);
	});
});

describe("calibrate: context_budget graduated adjustment", () => {
	it("high skip rate → higher budget", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, respondSkipped: 10, respond: 10 });
		// 50% → lerp(50, 0, 30, 1500, 2500) → 2500 (clamped at max)
		expect(cal.context_budget).toBe(2500);
	});

	it("zero skip rate → lower budget", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, respondSkipped: 0, respond: 50 });
		expect(cal.context_budget).toBe(1500);
	});

	it("insufficient data → default", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, respondSkipped: 0, respond: 5 });
		expect(cal.context_budget).toBe(2000);
	});
});

describe("calibrate: loc_limit graduated adjustment", () => {
	it("high fix effort → tighter LOC limit", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, avgFixEffort: 4, fixEffortTotal: 10 });
		expect(cal.loc_limit).toBe(150);
	});

	it("low fix effort → relaxed LOC limit", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, avgFixEffort: 1.0, fixEffortTotal: 8 });
		expect(cal.loc_limit).toBe(250);
	});
});

describe("calibrate: plan_task_threshold", () => {
	it("high plan compliance → relaxed threshold", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, planAvgCompliance: 90, planComplianceTotal: 5 });
		expect(cal.plan_task_threshold).toBe(5);
	});

	it("low plan compliance → tighter threshold", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, planAvgCompliance: 50, planComplianceTotal: 5 });
		expect(cal.plan_task_threshold).toBe(2);
	});

	it("insufficient plan data → default", async () => {
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, planComplianceTotal: 1 });
		expect(cal.plan_task_threshold).toBe(3);
	});
});

describe("calibrate: cold start with strict gates", () => {
	it("uses tighter defaults when many gates configured", async () => {
		// Create a gates.json with 4+ gates
		mkdirSync(join(TEST_DIR, ".qult"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, ".qult", "gates.json"),
			JSON.stringify({
				on_write: {
					lint: { command: "biome check {file}" },
					typecheck: { command: "tsc --noEmit" },
				},
				on_commit: { test: { command: "vitest run" }, e2e: { command: "playwright test" } },
			}),
		);
		const { calibrate } = await import("../state/calibration.ts");
		const cal = calibrate({ ...BASE_INPUT, firstPassTotal: 3 }); // cold start
		expect(cal.pace_files).toBe(10);
		expect(cal.loc_limit).toBe(150);
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
			plan_task_threshold: 4,
			review_score_threshold: 12,
			calibrated_at: "2026-03-28T00:00:00Z",
		};
		writeCalibration(cal);
		const read = readCalibration();
		expect(read).not.toBeNull();
		expect(read!.pace_files).toBe(20);
		expect(read!.loc_limit).toBe(150);
		expect(read!.plan_task_threshold).toBe(4);
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
			plan_task_threshold: 3,
			review_score_threshold: 12,
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
			plan_task_threshold: 3,
			review_score_threshold: 12,
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
			plan_task_threshold: 4,
			review_score_threshold: 13,
			calibrated_at: new Date().toISOString(),
		});
		expect(getCalibrated("pace_files", 15)).toBe(20);
		expect(getCalibrated("loc_limit", 200)).toBe(150);
		expect(getCalibrated("plan_task_threshold", 3)).toBe(4);
	});

	it("returns fallback when no calibration", async () => {
		const { getCalibrated } = await import("../state/calibration.ts");
		expect(getCalibrated("pace_files", 15)).toBe(15);
		expect(getCalibrated("context_budget", 2000)).toBe(2000);
	});
});
