import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, type QultConfig } from "../config.ts";
import { closeDb, getDb, getProjectId, setProjectPath, useTestDb } from "../state/db.ts";
import type { FlywheelRecommendation } from "../state/metrics.ts";
import { applyFlywheelRecommendations, transferKnowledge } from "../state/metrics.ts";

const TEST_DIR = "/tmp/.tmp-flywheel-auto-apply-test";
const TEST_DIR_2 = "/tmp/.tmp-flywheel-auto-apply-test-2";
const TEST_DIR_3 = "/tmp/.tmp-flywheel-auto-apply-test-3";

function makeConfig(overrides: Partial<QultConfig> = {}): QultConfig {
	return structuredClone({ ...DEFAULTS, ...overrides });
}

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
});

afterEach(() => {
	closeDb();
});

describe("applyFlywheelRecommendations", () => {
	it("raise direction writes to global_configs and returns applied: true", () => {
		const config = makeConfig();
		config.flywheel.auto_apply = true;
		const recs: FlywheelRecommendation[] = [
			{
				metric: "security",
				current_threshold: 10,
				suggested_threshold: 13,
				direction: "raise",
				confidence: "high",
				reason: "low frequency",
			},
		];

		const result = applyFlywheelRecommendations(recs, config);
		expect(result.applied).toHaveLength(1);
		expect(result.applied[0]!.metric).toBe("security");

		// Verify written to global_configs
		const db = getDb();
		const row = db
			.prepare("SELECT value FROM global_configs WHERE key = ?")
			.get("escalation.security_threshold") as { value: string } | null;
		expect(row).not.toBeNull();
		expect(JSON.parse(row!.value)).toBe(13);
	});

	it("lower direction is deferred, not written to global_configs", () => {
		const config = makeConfig();
		config.flywheel.auto_apply = true;
		const recs: FlywheelRecommendation[] = [
			{
				metric: "security",
				current_threshold: 10,
				suggested_threshold: 7,
				direction: "lower",
				confidence: "high",
				reason: "high frequency worsening",
			},
		];

		const result = applyFlywheelRecommendations(recs, config);
		expect(result.deferred).toHaveLength(1);
		expect(result.applied).toHaveLength(0);

		// Verify NOT written to global_configs
		const db = getDb();
		const row = db
			.prepare("SELECT value FROM global_configs WHERE key = ?")
			.get("escalation.security_threshold") as { value: string } | undefined;
		expect(row).toBeUndefined();
	});

	it("auto_apply=false skips all recommendations", () => {
		const config = makeConfig();
		config.flywheel.auto_apply = false;
		const recs: FlywheelRecommendation[] = [
			{
				metric: "security",
				current_threshold: 10,
				suggested_threshold: 13,
				direction: "raise",
				confidence: "high",
				reason: "low frequency",
			},
			{
				metric: "drift",
				current_threshold: 8,
				suggested_threshold: 5,
				direction: "lower",
				confidence: "medium",
				reason: "high frequency",
			},
		];

		const result = applyFlywheelRecommendations(recs, config);
		expect(result.applied).toHaveLength(0);
		expect(result.deferred).toHaveLength(2);
	});

	it("does not overwrite existing global_configs values", () => {
		const db = getDb();
		db.prepare("INSERT INTO global_configs (key, value) VALUES (?, ?)").run(
			"escalation.security_threshold",
			JSON.stringify(20),
		);

		const config = makeConfig();
		config.flywheel.auto_apply = true;
		const recs: FlywheelRecommendation[] = [
			{
				metric: "security",
				current_threshold: 10,
				suggested_threshold: 13,
				direction: "raise",
				confidence: "high",
				reason: "low frequency",
			},
		];

		const result = applyFlywheelRecommendations(recs, config);
		expect(result.deferred).toHaveLength(1);
		expect(result.applied).toHaveLength(0);

		// Verify original value preserved
		const row = db
			.prepare("SELECT value FROM global_configs WHERE key = ?")
			.get("escalation.security_threshold") as { value: string };
		expect(JSON.parse(row.value)).toBe(20);
	});
});

describe("SessionStart flywheel integration", () => {
	it("SessionStart calls applyFlywheelRecommendations when auto_apply=true", async () => {
		const db = getDb();
		const projectId = getProjectId();

		// Insert 20 sessions with security_warnings=0 (stable, low frequency)
		for (let i = 0; i < 20; i++) {
			db.prepare(
				`INSERT INTO session_metrics (session_id, project_id, gate_failure_count, security_warning_count, review_aggregate, files_changed, test_quality_warning_count, duplication_warning_count, semantic_warning_count, drift_warning_count, escalation_hit)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(`session-start-test-${i}`, projectId, 0, 0, null, 1, 0, 0, 0, 0, 0);
		}

		// Set flywheel config via project_configs
		db.prepare(
			"INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)",
		).run(projectId, "flywheel.enabled", JSON.stringify(true));
		db.prepare(
			"INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)",
		).run(projectId, "flywheel.auto_apply", JSON.stringify(true));
		db.prepare(
			"INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)",
		).run(projectId, "flywheel.min_sessions", JSON.stringify(10));

		const sessionStart = (await import("../hooks/session-start.ts")).default;
		await sessionStart({ hook_event_name: "SessionStart", source: "startup", cwd: TEST_DIR });

		// Verify that global_configs was written with a raised threshold
		const row = db
			.prepare("SELECT value FROM global_configs WHERE key = ?")
			.get("escalation.security_threshold") as { value: string } | null;
		expect(row).not.toBeNull();
		expect(JSON.parse(row!.value)).toBeGreaterThan(DEFAULTS.escalation.security_threshold);
	});
});

describe("transferKnowledge", () => {
	function insertMetricsForProject(
		projectPath: string,
		sessions: { metric: string; count: number }[],
	): void {
		const db = getDb();
		setProjectPath(projectPath);
		const pid = getProjectId();
		for (let i = 0; i < sessions.length; i++) {
			const s = sessions[i]!;
			const sec = s.metric === "security_warning" ? s.count : 0;
			const tq = s.metric === "test_quality_warning" ? s.count : 0;
			const dup = s.metric === "duplication_warning" ? s.count : 0;
			const sem = s.metric === "semantic_warning" ? s.count : 0;
			const drift = s.metric === "drift_warning" ? s.count : 0;
			db.prepare(
				`INSERT INTO session_metrics (session_id, project_id, gate_failure_count, security_warning_count, review_aggregate, files_changed, test_quality_warning_count, duplication_warning_count, semantic_warning_count, drift_warning_count, escalation_hit)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(`s-${projectPath}-${i}`, pid, 0, sec, null, 1, tq, dup, sem, drift, 0);
		}
	}

	it("3+ projects with common security pattern writes to global_configs", () => {
		// Create 3 projects each with high security warning frequency
		for (const path of [TEST_DIR, TEST_DIR_2, TEST_DIR_3]) {
			const sessions = [];
			for (let i = 0; i < 10; i++) {
				sessions.push({ metric: "security_warning", count: i < 7 ? 3 : 0 });
			}
			insertMetricsForProject(path, sessions);
		}

		setProjectPath(TEST_DIR);
		const result = transferKnowledge();
		expect(result.patterns.length).toBeGreaterThan(0);
		expect(result.patterns.some((p) => p.includes("security"))).toBe(true);
	});

	it("generates rule templates for security patterns", () => {
		for (const path of [TEST_DIR, TEST_DIR_2, TEST_DIR_3]) {
			const sessions = [];
			for (let i = 0; i < 10; i++) {
				sessions.push({ metric: "security_warning", count: 3 });
			}
			insertMetricsForProject(path, sessions);
		}

		setProjectPath(TEST_DIR);
		const result = transferKnowledge();
		const secTemplate = result.templates.find((t) => t.filename.includes("security"));
		expect(secTemplate).toBeDefined();
		expect(secTemplate!.content.length).toBeGreaterThan(0);
	});
});
