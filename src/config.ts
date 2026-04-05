import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** User-configurable settings in .qult/config.json */
export interface QultConfig {
	review: {
		score_threshold: number;
		max_iterations: number;
		required_changed_files: number;
		dimension_floor: number;
		require_human_approval: boolean;
	};
	plan_eval: {
		score_threshold: number;
		max_iterations: number;
		/** File paths that trigger consumer-coverage heuristic. Config file only (no env var). */
		registry_files: string[];
	};
	gates: {
		output_max_chars: number;
		default_timeout: number;
		/** Run related test file on edit (opt-in). Requires on_commit.test gate. */
		test_on_edit: boolean;
		/** Timeout for test-on-edit gate in ms (default: 15000) */
		test_on_edit_timeout: number;
		/** Additional PATH directories for gate command execution (e.g. [".venv/bin", "../node_modules/.bin"]) */
		extra_path: string[];
	};
}

const DEFAULTS: QultConfig = {
	review: {
		score_threshold: 34,
		max_iterations: 3,
		required_changed_files: 5,
		dimension_floor: 4,
		require_human_approval: false,
	},
	plan_eval: {
		score_threshold: 10,
		max_iterations: 2,
		registry_files: [],
	},
	gates: {
		output_max_chars: 2000,
		default_timeout: 10000,
		test_on_edit: false,
		test_on_edit_timeout: 15000,
		extra_path: [],
	},
};

/** Apply a raw config object on top of an existing QultConfig (field-by-field type-safe merge). */
function applyConfigLayer(config: QultConfig, raw: Record<string, unknown>): void {
	if (raw.review && typeof raw.review === "object") {
		const r = raw.review as Record<string, unknown>;
		if (typeof r.score_threshold === "number") config.review.score_threshold = r.score_threshold;
		if (typeof r.max_iterations === "number") config.review.max_iterations = r.max_iterations;
		if (typeof r.required_changed_files === "number")
			config.review.required_changed_files = Math.max(1, r.required_changed_files);
		if (typeof r.dimension_floor === "number")
			config.review.dimension_floor = Math.max(1, Math.min(5, r.dimension_floor));
		if (typeof r.require_human_approval === "boolean")
			config.review.require_human_approval = r.require_human_approval;
	}
	if (raw.plan_eval && typeof raw.plan_eval === "object") {
		const p = raw.plan_eval as Record<string, unknown>;
		if (typeof p.score_threshold === "number") config.plan_eval.score_threshold = p.score_threshold;
		if (typeof p.max_iterations === "number") config.plan_eval.max_iterations = p.max_iterations;
		if (Array.isArray(p.registry_files))
			config.plan_eval.registry_files = p.registry_files.filter(
				(f: unknown) => typeof f === "string",
			);
	}
	if (raw.gates && typeof raw.gates === "object") {
		const g = raw.gates as Record<string, unknown>;
		if (typeof g.output_max_chars === "number") config.gates.output_max_chars = g.output_max_chars;
		if (typeof g.default_timeout === "number") config.gates.default_timeout = g.default_timeout;
		if (typeof g.test_on_edit === "boolean") config.gates.test_on_edit = g.test_on_edit;
		if (typeof g.test_on_edit_timeout === "number")
			config.gates.test_on_edit_timeout = g.test_on_edit_timeout;
		if (Array.isArray(g.extra_path))
			config.gates.extra_path = g.extra_path.filter(
				(p: unknown) => typeof p === "string" && p.trim().length > 0,
			);
	}
}

// Process-scoped cache
let _cache: QultConfig | null = null;

/** Load config with layered precedence: defaults → .qult/config.json → QULT_* env vars */
export function loadConfig(): QultConfig {
	if (_cache) return _cache;

	const config = structuredClone(DEFAULTS);

	// Layer 0.5: ${CLAUDE_PLUGIN_DATA}/preferences.json (user-level cross-project)
	try {
		const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
		if (pluginDataDir) {
			const prefsPath = join(pluginDataDir, "preferences.json");
			if (existsSync(prefsPath)) {
				const raw = JSON.parse(readFileSync(prefsPath, "utf-8"));
				applyConfigLayer(config, raw);
			}
		}
	} catch {
		// fail-open: use defaults
	}

	// Layer 1: .qult/config.json (project-level)
	try {
		const configPath = join(process.cwd(), ".qult", "config.json");
		if (existsSync(configPath)) {
			const raw = JSON.parse(readFileSync(configPath, "utf-8"));
			applyConfigLayer(config, raw);
		}
	} catch {
		// fail-open: use defaults
	}

	// Layer 2: QULT_* environment variables
	const envInt = (key: string): number | undefined => {
		const val = process.env[key];
		if (val === undefined) return undefined;
		const n = Number.parseInt(val, 10);
		return Number.isNaN(n) ? undefined : n;
	};

	config.review.score_threshold =
		envInt("QULT_REVIEW_SCORE_THRESHOLD") ?? config.review.score_threshold;
	config.review.max_iterations =
		envInt("QULT_REVIEW_MAX_ITERATIONS") ?? config.review.max_iterations;
	config.review.required_changed_files =
		envInt("QULT_REVIEW_REQUIRED_FILES") ?? config.review.required_changed_files;
	const rawFloor = envInt("QULT_REVIEW_DIMENSION_FLOOR");
	if (rawFloor !== undefined) config.review.dimension_floor = Math.max(1, Math.min(5, rawFloor));
	config.plan_eval.score_threshold =
		envInt("QULT_PLAN_EVAL_SCORE_THRESHOLD") ?? config.plan_eval.score_threshold;
	config.plan_eval.max_iterations =
		envInt("QULT_PLAN_EVAL_MAX_ITERATIONS") ?? config.plan_eval.max_iterations;
	config.gates.output_max_chars = envInt("QULT_GATE_OUTPUT_MAX") ?? config.gates.output_max_chars;
	config.gates.default_timeout =
		envInt("QULT_GATE_DEFAULT_TIMEOUT") ?? config.gates.default_timeout;
	const humanApprovalEnv = process.env.QULT_REQUIRE_HUMAN_APPROVAL;
	if (humanApprovalEnv === "1" || humanApprovalEnv === "true")
		config.review.require_human_approval = true;
	else if (humanApprovalEnv === "0" || humanApprovalEnv === "false")
		config.review.require_human_approval = false;
	const testOnEditEnv = process.env.QULT_TEST_ON_EDIT;
	if (testOnEditEnv === "1" || testOnEditEnv === "true") config.gates.test_on_edit = true;
	else if (testOnEditEnv === "0" || testOnEditEnv === "false") config.gates.test_on_edit = false;
	config.gates.test_on_edit_timeout =
		envInt("QULT_TEST_ON_EDIT_TIMEOUT") ?? config.gates.test_on_edit_timeout;

	_cache = config;
	return config;
}

/** Reset cache (for tests). */
export function resetConfigCache(): void {
	_cache = null;
}
