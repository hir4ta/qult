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
	delete process.env.QULT_ESCALATION_SEMANTIC;
	delete process.env.QULT_REVIEW_MODEL_SPEC;
	delete process.env.QULT_REVIEW_MODEL_QUALITY;
	delete process.env.QULT_REVIEW_MODEL_SECURITY;
	delete process.env.QULT_REVIEW_MODEL_ADVERSARIAL;
	delete process.env.QULT_PLAN_EVAL_MODEL_GENERATOR;
	delete process.env.QULT_PLAN_EVAL_MODEL_EVALUATOR;
	delete process.env.QULT_FLYWHEEL_ENABLED;
	delete process.env.QULT_FLYWHEEL_MIN_SESSIONS;
	delete process.env.QULT_REQUIRE_SEMGREP;
	delete process.env.QULT_ESCALATION_SECURITY_ITERATIVE;
	delete process.env.QULT_ESCALATION_DEAD_IMPORT_BLOCKING;
	delete process.env.QULT_COVERAGE_THRESHOLD;
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

describe("review.models config", () => {
	it("returns default model values", () => {
		const config = loadConfig();
		expect(config.review.models).toEqual({
			spec: "opus",
			quality: "opus",
			security: "opus",
			adversarial: "opus",
		});
	});

	it("reads models from project config", () => {
		setProjectConfig("review.models.spec", "opus");
		setProjectConfig("review.models.adversarial", "haiku");
		const config = loadConfig();
		expect(config.review.models.spec).toBe("opus");
		expect(config.review.models.adversarial).toBe("haiku");
		// Unset values keep defaults
		expect(config.review.models.quality).toBe("opus");
		expect(config.review.models.security).toBe("opus");
	});

	it("env vars override model config", () => {
		setProjectConfig("review.models.spec", "opus");
		process.env.QULT_REVIEW_MODEL_SPEC = "haiku";
		const config = loadConfig();
		expect(config.review.models.spec).toBe("haiku");
	});

	it("supports all model env vars", () => {
		process.env.QULT_REVIEW_MODEL_SPEC = "opus";
		process.env.QULT_REVIEW_MODEL_QUALITY = "haiku";
		process.env.QULT_REVIEW_MODEL_SECURITY = "sonnet";
		process.env.QULT_REVIEW_MODEL_ADVERSARIAL = "opus";
		const config = loadConfig();
		expect(config.review.models.spec).toBe("opus");
		expect(config.review.models.quality).toBe("haiku");
		expect(config.review.models.security).toBe("sonnet");
		expect(config.review.models.adversarial).toBe("opus");
	});

	it("ignores empty string env vars for models", () => {
		process.env.QULT_REVIEW_MODEL_SPEC = "";
		const config = loadConfig();
		expect(config.review.models.spec).toBe("opus"); // default
	});
});

describe("plan_eval.models config", () => {
	it("returns default plan_eval model values", () => {
		const config = loadConfig();
		expect(config.plan_eval.models).toEqual({
			generator: "opus",
			evaluator: "opus",
		});
	});

	it("reads plan_eval models from project config", () => {
		setProjectConfig("plan_eval.models.generator", "sonnet");
		const config = loadConfig();
		expect(config.plan_eval.models.generator).toBe("sonnet");
		expect(config.plan_eval.models.evaluator).toBe("opus");
	});

	it("env vars override plan_eval models", () => {
		process.env.QULT_PLAN_EVAL_MODEL_GENERATOR = "haiku";
		process.env.QULT_PLAN_EVAL_MODEL_EVALUATOR = "sonnet";
		const config = loadConfig();
		expect(config.plan_eval.models.generator).toBe("haiku");
		expect(config.plan_eval.models.evaluator).toBe("sonnet");
	});
});

describe("flywheel config", () => {
	it("returns default flywheel values", () => {
		const config = loadConfig();
		expect(config.flywheel).toEqual({
			enabled: true,
			min_sessions: 10,
		});
	});

	it("reads flywheel from project config", () => {
		setProjectConfig("flywheel.enabled", false);
		setProjectConfig("flywheel.min_sessions", 20);
		const config = loadConfig();
		expect(config.flywheel.enabled).toBe(false);
		expect(config.flywheel.min_sessions).toBe(20);
	});

	it("env vars override flywheel config", () => {
		process.env.QULT_FLYWHEEL_ENABLED = "false";
		process.env.QULT_FLYWHEEL_MIN_SESSIONS = "5";
		const config = loadConfig();
		expect(config.flywheel.enabled).toBe(false);
		expect(config.flywheel.min_sessions).toBe(5);
	});

	it("handles boolean env var variations", () => {
		process.env.QULT_FLYWHEEL_ENABLED = "0";
		const config = loadConfig();
		expect(config.flywheel.enabled).toBe(false);

		resetConfigCache();
		process.env.QULT_FLYWHEEL_ENABLED = "1";
		const config2 = loadConfig();
		expect(config2.flywheel.enabled).toBe(true);
	});

	it("enforces minimum of 1 for min_sessions", () => {
		setProjectConfig("flywheel.min_sessions", 0);
		const config = loadConfig();
		expect(config.flywheel.min_sessions).toBe(1);
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

	it("returns default security_iterative_threshold", () => {
		const config = loadConfig();
		expect(config.escalation.security_iterative_threshold).toBe(5);
	});

	it("reads security_iterative_threshold from project config", () => {
		setProjectConfig("escalation.security_iterative_threshold", 3);
		const config = loadConfig();
		expect(config.escalation.security_iterative_threshold).toBe(3);
	});

	it("env var overrides security_iterative_threshold", () => {
		process.env.QULT_ESCALATION_SECURITY_ITERATIVE = "7";
		const config = loadConfig();
		expect(config.escalation.security_iterative_threshold).toBe(7);
	});

	it("returns default dead_import_blocking_threshold", () => {
		const config = loadConfig();
		expect(config.escalation.dead_import_blocking_threshold).toBe(5);
	});

	it("reads dead_import_blocking_threshold from project config", () => {
		setProjectConfig("escalation.dead_import_blocking_threshold", 10);
		const config = loadConfig();
		expect(config.escalation.dead_import_blocking_threshold).toBe(10);
	});

	it("env var overrides dead_import_blocking_threshold", () => {
		process.env.QULT_ESCALATION_DEAD_IMPORT_BLOCKING = "3";
		const config = loadConfig();
		expect(config.escalation.dead_import_blocking_threshold).toBe(3);
	});
});

describe("security config", () => {
	it("returns default require_semgrep as true", () => {
		const config = loadConfig();
		expect(config.security.require_semgrep).toBe(true);
	});

	it("reads require_semgrep from project config", () => {
		setProjectConfig("security.require_semgrep", false);
		const config = loadConfig();
		expect(config.security.require_semgrep).toBe(false);
	});

	it("env var overrides require_semgrep", () => {
		process.env.QULT_REQUIRE_SEMGREP = "false";
		const config = loadConfig();
		expect(config.security.require_semgrep).toBe(false);

		resetConfigCache();
		process.env.QULT_REQUIRE_SEMGREP = "1";
		const config2 = loadConfig();
		expect(config2.security.require_semgrep).toBe(true);
	});
});

describe("coverage_threshold config", () => {
	it("returns default coverage_threshold as 0 (opt-in)", () => {
		const config = loadConfig();
		expect(config.gates.coverage_threshold).toBe(0);
	});

	it("reads coverage_threshold from project config", () => {
		setProjectConfig("gates.coverage_threshold", 80);
		const config = loadConfig();
		expect(config.gates.coverage_threshold).toBe(80);
	});

	it("env var QULT_COVERAGE_THRESHOLD overrides project config", () => {
		setProjectConfig("gates.coverage_threshold", 80);
		process.env.QULT_COVERAGE_THRESHOLD = "90";
		const config = loadConfig();
		expect(config.gates.coverage_threshold).toBe(90);
	});

	it("clamps negative values to 0", () => {
		process.env.QULT_COVERAGE_THRESHOLD = "-10";
		const config = loadConfig();
		expect(config.gates.coverage_threshold).toBe(0);
	});

	it("clamps values above 100 to 100", () => {
		process.env.QULT_COVERAGE_THRESHOLD = "150";
		const config = loadConfig();
		expect(config.gates.coverage_threshold).toBe(100);
	});
});
