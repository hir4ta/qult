import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../config.ts";
import {
	closeDb,
	ensureSession,
	getDb,
	getProjectId,
	setProjectPath,
	setSessionScope,
	useTestDb,
} from "../state/db.ts";

const TEST_DIR = "/tmp/.tmp-config-test";

function setProjectConfig(key: string, value: unknown): void {
	const db = getDb();
	const projectId = getProjectId();
	db.prepare(
		"INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)",
	).run(projectId, key, JSON.stringify(value));
}

function setGlobalConfig(key: string, value: unknown): void {
	const db = getDb();
	db.prepare("INSERT OR REPLACE INTO global_configs (key, value) VALUES (?, ?)").run(
		key,
		JSON.stringify(value),
	);
}

beforeEach(() => {
	useTestDb();
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
	resetConfigCache();
});

afterEach(() => {
	closeDb();
	// Clean env vars
	delete process.env.QULT_REVIEW_SCORE_THRESHOLD;
	delete process.env.QULT_REVIEW_MAX_ITERATIONS;
	delete process.env.QULT_REVIEW_REQUIRED_FILES;
	delete process.env.QULT_GATE_OUTPUT_MAX;
	delete process.env.QULT_GATE_DEFAULT_TIMEOUT;
	delete process.env.QULT_REVIEW_DIMENSION_FLOOR;
	delete process.env.CLAUDE_PLUGIN_DATA;
	delete process.env.QULT_ESCALATION_SECURITY;
	delete process.env.QULT_ESCALATION_DRIFT;
	delete process.env.QULT_ESCALATION_TEST_QUALITY;
	delete process.env.QULT_ESCALATION_DUPLICATION;
});

describe("loadConfig", () => {
	it("returns defaults when no config exists", () => {
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(30);
		expect(config.review.max_iterations).toBe(3);
		expect(config.review.required_changed_files).toBe(5);
		expect(config.review.dimension_floor).toBe(4);
		expect(config.gates.output_max_chars).toBe(3500);
		expect(config.gates.default_timeout).toBe(10000);
		expect(config.escalation.security_threshold).toBe(10);
		expect(config.escalation.drift_threshold).toBe(8);
	});

	it("reads from project_configs DB", () => {
		setProjectConfig("review.score_threshold", 10);
		setProjectConfig("review.max_iterations", 5);
		setProjectConfig("gates.output_max_chars", 3000);
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(10);
		expect(config.review.max_iterations).toBe(5);
		// Unset values keep defaults
		expect(config.review.required_changed_files).toBe(5);
		expect(config.gates.output_max_chars).toBe(3000);
		expect(config.gates.default_timeout).toBe(10000);
	});

	it("env vars override project config", () => {
		setProjectConfig("review.score_threshold", 10);
		process.env.QULT_REVIEW_SCORE_THRESHOLD = "14";
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(14);
	});

	it("ignores invalid env var values", () => {
		process.env.QULT_REVIEW_SCORE_THRESHOLD = "not-a-number";
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(30); // default
	});

	it("handles missing project config gracefully", () => {
		// No project_configs inserted → should return defaults
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(30); // default
	});

	it("caches result across calls", () => {
		const config1 = loadConfig();
		const config2 = loadConfig();
		expect(config1).toBe(config2); // same reference
	});

	it("supports all env var overrides", () => {
		process.env.QULT_REVIEW_SCORE_THRESHOLD = "9";
		process.env.QULT_REVIEW_MAX_ITERATIONS = "2";
		process.env.QULT_REVIEW_REQUIRED_FILES = "3";
		process.env.QULT_REVIEW_DIMENSION_FLOOR = "4";
		process.env.QULT_GATE_OUTPUT_MAX = "1500";
		process.env.QULT_GATE_DEFAULT_TIMEOUT = "5000";
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(9);
		expect(config.review.max_iterations).toBe(2);
		expect(config.review.required_changed_files).toBe(3);
		expect(config.review.dimension_floor).toBe(4);
		expect(config.gates.output_max_chars).toBe(1500);
		expect(config.gates.default_timeout).toBe(5000);
	});

	it("reads dimension_floor from project config", () => {
		setProjectConfig("review.dimension_floor", 2);
		const config = loadConfig();
		expect(config.review.dimension_floor).toBe(2);
		// Other defaults preserved
		expect(config.review.score_threshold).toBe(30);
	});
});

describe("global_configs layer", () => {
	it("reads from global_configs", () => {
		setGlobalConfig("review.score_threshold", 10);
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(10);
	});

	it("project config overrides global_configs", () => {
		setGlobalConfig("review.score_threshold", 10);
		setProjectConfig("review.score_threshold", 14);
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(14);
	});

	it("env vars override global_configs", () => {
		setGlobalConfig("review.score_threshold", 10);
		process.env.QULT_REVIEW_SCORE_THRESHOLD = "15";
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(15);
	});

	it("returns defaults when no global_configs exist", () => {
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(30); // default
	});
});

describe("extra_path validation", () => {
	it("rejects empty strings in extra_path", () => {
		setProjectConfig("gates.extra_path", ["", ".venv/bin", "  ", "/usr/local/bin"]);
		const config = loadConfig();
		// Empty strings and whitespace-only strings should be filtered out
		expect(config.gates.extra_path).toEqual([".venv/bin", "/usr/local/bin"]);
	});

	it("accepts valid paths in extra_path", () => {
		setProjectConfig("gates.extra_path", [".venv/bin", "/usr/local/bin", "../node_modules/.bin"]);
		const config = loadConfig();
		expect(config.gates.extra_path).toEqual([
			".venv/bin",
			"/usr/local/bin",
			"../node_modules/.bin",
		]);
	});

	it("ignores non-string items in extra_path", () => {
		setProjectConfig("gates.extra_path", [".venv/bin", 123, null, "/usr/local/bin"]);
		const config = loadConfig();
		expect(config.gates.extra_path).toEqual([".venv/bin", "/usr/local/bin"]);
	});
});

describe("escalation config", () => {
	it("reads escalation from project config", () => {
		setProjectConfig("escalation.security_threshold", 5);
		setProjectConfig("escalation.drift_threshold", 3);
		const config = loadConfig();
		expect(config.escalation.security_threshold).toBe(5);
		expect(config.escalation.drift_threshold).toBe(3);
		expect(config.escalation.test_quality_threshold).toBe(8);
	});

	it("env vars override escalation config", () => {
		process.env.QULT_ESCALATION_SECURITY = "15";
		const config = loadConfig();
		expect(config.escalation.security_threshold).toBe(15);
	});

	it("enforces minimum of 1 for escalation thresholds", () => {
		setProjectConfig("escalation.security_threshold", 0);
		setProjectConfig("escalation.drift_threshold", -5);
		const config = loadConfig();
		expect(config.escalation.security_threshold).toBe(1);
		expect(config.escalation.drift_threshold).toBe(1);
	});
});
