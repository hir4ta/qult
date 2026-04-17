import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../config.ts";
import { closeDb, getDb, getProjectId, setProjectPath, useTestDb } from "../state/db.ts";

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
	delete process.env.QULT_CONSUMER_TYPECHECK;
	delete process.env.QULT_IMPORT_GRAPH_DEPTH;
	delete process.env.QULT_REQUIRE_OSV_SCANNER;
	delete process.env.QULT_REVIEW_LOW_ONLY_PASSES;
	delete process.env.QULT_REQUIRE_HUMAN_APPROVAL;
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
			spec: "sonnet",
			quality: "sonnet",
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
		expect(config.review.models.quality).toBe("sonnet");
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
		expect(config.review.models.spec).toBe("sonnet"); // default
	});
});

describe("plan_eval.models config", () => {
	it("returns default plan_eval model values", () => {
		const config = loadConfig();
		expect(config.plan_eval.models).toEqual({
			generator: "sonnet",
			evaluator: "opus",
		});
	});

	it("reads plan_eval models from project config", () => {
		setProjectConfig("plan_eval.models.generator", "haiku");
		const config = loadConfig();
		expect(config.plan_eval.models.generator).toBe("haiku");
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

describe("review.low_only_passes config", () => {
	it("returns default low_only_passes as false", () => {
		const config = loadConfig();
		expect(config.review.low_only_passes).toBe(false);
	});

	it("reads low_only_passes from project config", () => {
		setProjectConfig("review.low_only_passes", true);
		const config = loadConfig();
		expect(config.review.low_only_passes).toBe(true);
	});

	it("env var QULT_REVIEW_LOW_ONLY_PASSES overrides with true/1/false/0", () => {
		process.env.QULT_REVIEW_LOW_ONLY_PASSES = "true";
		const config = loadConfig();
		expect(config.review.low_only_passes).toBe(true);

		resetConfigCache();
		process.env.QULT_REVIEW_LOW_ONLY_PASSES = "1";
		const config2 = loadConfig();
		expect(config2.review.low_only_passes).toBe(true);

		resetConfigCache();
		process.env.QULT_REVIEW_LOW_ONLY_PASSES = "0";
		const config3 = loadConfig();
		expect(config3.review.low_only_passes).toBe(false);

		resetConfigCache();
		process.env.QULT_REVIEW_LOW_ONLY_PASSES = "false";
		const config4 = loadConfig();
		expect(config4.review.low_only_passes).toBe(false);
	});

	it("env var overrides project config (env wins)", () => {
		setProjectConfig("review.low_only_passes", true);
		process.env.QULT_REVIEW_LOW_ONLY_PASSES = "0";
		const config = loadConfig();
		expect(config.review.low_only_passes).toBe(false);
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

describe("import_graph_depth config", () => {
	it("loads import_graph_depth from env", () => {
		process.env.QULT_IMPORT_GRAPH_DEPTH = "2";
		const config = loadConfig();
		expect(config.gates.import_graph_depth).toBe(2);
	});

	it("clamps import_graph_depth to max 3", () => {
		process.env.QULT_IMPORT_GRAPH_DEPTH = "10";
		const config = loadConfig();
		expect(config.gates.import_graph_depth).toBe(3);
	});

	it("defaults import_graph_depth to 1", () => {
		const config = loadConfig();
		expect(config.gates.import_graph_depth).toBe(1);
	});
});
