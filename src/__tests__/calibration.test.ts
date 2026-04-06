import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkCalibration,
	projectId,
	readCalibration,
	recordCalibration,
} from "../state/calibration.ts";

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
	it("returns insufficient data warning for new projects (1-2 reviews)", () => {
		recordCalibration(28, {});
		const warnings = checkCalibration();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]!.type).toBe("low_variance");
		expect(warnings[0]!.message).toContain("only 1 review");
	});

	it("returns empty warnings with zero data", () => {
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
		const perfectStages = {
			Spec: { completeness: 5, accuracy: 5 },
			Quality: { design: 5, maintainability: 5 },
			Security: { vulnerability: 5, hardening: 5 },
			Adversarial: { edgecases: 5, logiccorrectness: 5 },
		};
		recordCalibration(26, {});
		recordCalibration(26, {});
		recordCalibration(40, perfectStages);
		recordCalibration(40, perfectStages);
		recordCalibration(40, perfectStages);
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

describe("projectId (Task 12)", () => {
	it("returns a 12-character hex string", () => {
		const id = projectId();
		expect(id).toMatch(/^[0-9a-f]{12}$/);
	});

	it("returns the same value for the same cwd", () => {
		expect(projectId()).toBe(projectId());
	});
});

describe("checkCalibration: project-scoped filtering (Task 12)", () => {
	it("excludes entries from a different project", () => {
		const currentProject = projectId();
		const otherProject = currentProject === "aaaaaaaaaaaa" ? "bbbbbbbbbbbb" : "aaaaaaaaaaaa";

		// Record 6 entries: 3 from current project (high scores), 3 from another project (low scores)
		// If filtering works, only current-project entries should be checked (< 5 → no warnings)
		const data = {
			entries: [
				{ date: "2024-01-01", aggregate: 29, stages: {}, project: currentProject },
				{ date: "2024-01-02", aggregate: 29, stages: {}, project: currentProject },
				{ date: "2024-01-03", aggregate: 29, stages: {}, project: currentProject },
				{ date: "2024-01-04", aggregate: 15, stages: {}, project: otherProject },
				{ date: "2024-01-05", aggregate: 15, stages: {}, project: otherProject },
				{ date: "2024-01-06", aggregate: 15, stages: {}, project: otherProject },
			],
			stats: { count: 6, mean: 22, stddev: 7 },
		};
		writeFileSync(join(PLUGIN_DATA, "review-calibration.json"), JSON.stringify(data));

		// Only 3 current-project entries → below minimum of 5 → no warnings
		const warnings = checkCalibration();
		expect(warnings.length).toBe(0);
	});

	it("includes legacy entries without project field (backward compat)", () => {
		const data = {
			entries: [
				{ date: "2024-01-01", aggregate: 29, stages: {} },
				{ date: "2024-01-02", aggregate: 29, stages: {} },
				{ date: "2024-01-03", aggregate: 29, stages: {} },
				{ date: "2024-01-04", aggregate: 29, stages: {} },
				{ date: "2024-01-05", aggregate: 29, stages: {} },
				{ date: "2024-01-06", aggregate: 29, stages: {} },
			],
			stats: { count: 6, mean: 29, stddev: 0 },
		};
		writeFileSync(join(PLUGIN_DATA, "review-calibration.json"), JSON.stringify(data));

		const warnings = checkCalibration();
		// Legacy entries (no project) treated as all-project → all 6 included
		// mean=29, stddev=0 — high_mean warning should fire (mean > maxObserved * 0.93, stddev < 1.5)
		expect(warnings.length).toBeGreaterThan(0);
	});
});
