import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkCalibration,
	projectId,
	readCalibration,
	recordCalibration,
} from "../state/calibration.ts";
import {
	closeDb,
	ensureSession,
	getDb,
	setProjectPath,
	setSessionScope,
	useTestDb,
} from "../state/db.ts";

const TEST_DIR = "/tmp/.tmp-calibration-test";

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
});

afterEach(() => {
	closeDb();
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
});

describe("projectId (Task 12)", () => {
	it("returns a string representation of the project ID", () => {
		const id = projectId();
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
	});

	it("returns the same value for the same project", () => {
		expect(projectId()).toBe(projectId());
	});
});

describe("checkCalibration: project-scoped filtering (Task 12)", () => {
	it("excludes entries from a different project", () => {
		const _currentProject = projectId();

		// Record 3 entries for current project
		recordCalibration(29, {});
		recordCalibration(29, {});
		recordCalibration(29, {});

		// Insert entries for a different project directly
		const db = getDb();
		db.prepare("INSERT OR IGNORE INTO projects (path) VALUES (?)").run("/other/project");
		const otherRow = db.prepare("SELECT id FROM projects WHERE path = ?").get("/other/project") as {
			id: number;
		};
		db.prepare("INSERT OR IGNORE INTO sessions (id, project_id) VALUES (?, ?)").run(
			"other-session",
			otherRow.id,
		);
		for (let i = 0; i < 3; i++) {
			db.prepare(
				"INSERT INTO calibration (project_id, session_id, aggregate, stages) VALUES (?, ?, ?, ?)",
			).run(otherRow.id, "other-session", 15, "{}");
		}

		// Only 3 current-project entries → below minimum of 5 → no warnings
		const warnings = checkCalibration();
		expect(warnings.length).toBe(0);
	});

	it("includes all entries from current project", () => {
		// Record 6 entries for current project with high mean
		for (let i = 0; i < 6; i++) {
			recordCalibration(29, {});
		}

		const warnings = checkCalibration();
		// All 6 included → high_mean warning should fire
		expect(warnings.length).toBeGreaterThan(0);
	});
});
