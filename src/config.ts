import { getDb, getProjectId } from "./state/db.ts";

/** User-configurable settings */
export interface QultConfig {
	review: {
		score_threshold: number;
		max_iterations: number;
		required_changed_files: number;
		dimension_floor: number;
		require_human_approval: boolean;
		/** Per-stage reviewer model override. Values: "sonnet", "opus", "haiku", "inherit" */
		models: {
			spec: string;
			quality: string;
			security: string;
			adversarial: string;
		};
	};
	plan_eval: {
		score_threshold: number;
		max_iterations: number;
		/** File paths that trigger consumer-coverage heuristic. Config file only (no env var). */
		registry_files: string[];
		/** Model overrides for plan agents */
		models: {
			generator: string;
			evaluator: string;
		};
	};
	gates: {
		output_max_chars: number;
		default_timeout: number;
		/** Run related test file on edit (opt-in). Requires on_commit.test gate. */
		test_on_edit: boolean;
		/** Timeout for test-on-edit gate in ms (default: 15000) */
		test_on_edit_timeout: number;
		/** Additional PATH directories for gate command execution */
		extra_path: string[];
		/** Minimum test coverage percentage to pass. 0 = disabled (opt-in). */
		coverage_threshold: number;
		/** Re-run typecheck on consumer files when a dependency changes (opt-in). */
		consumer_typecheck: boolean;
		/** Import graph traversal depth for consumer detection (1-3). */
		import_graph_depth: number;
		/** Cyclomatic complexity threshold for code quality gate. */
		complexity_threshold: number;
		/** Maximum function size in lines for code quality gate. */
		function_size_limit: number;
		/** Minimum mutation score percentage to pass. 0 = disabled (opt-in). */
		mutation_score_threshold: number;
	};
	/** Security enforcement */
	security: {
		/** Require Semgrep to be installed. Blocks commit when missing. */
		require_semgrep: boolean;
		/** Require osv-scanner to be installed. Advisory when missing (default: false). */
		require_osv_scanner: boolean;
	};
	escalation: {
		security_threshold: number;
		drift_threshold: number;
		test_quality_threshold: number;
		duplication_threshold: number;
		semantic_threshold: number;
		/** Same-file edit count before promoting security advisories to blocking */
		security_iterative_threshold: number;
		/** Dead-import warning count before promoting to blocking */
		dead_import_blocking_threshold: number;
	};
	/** Cross-session learning: threshold adjustment recommendations */
	flywheel: {
		enabled: boolean;
		min_sessions: number;
		/** Automatically apply safe (raise) recommendations to global_configs */
		auto_apply: boolean;
	};
}

export const DEFAULTS: QultConfig = {
	review: {
		score_threshold: 30,
		max_iterations: 3,
		required_changed_files: 5,
		dimension_floor: 4,
		require_human_approval: false,
		models: {
			spec: "sonnet",
			quality: "sonnet",
			security: "opus",
			adversarial: "opus",
		},
	},
	plan_eval: {
		score_threshold: 12,
		max_iterations: 2,
		registry_files: [],
		models: {
			generator: "sonnet",
			evaluator: "opus",
		},
	},
	gates: {
		output_max_chars: 3500,
		default_timeout: 10000,
		test_on_edit: false,
		test_on_edit_timeout: 15000,
		extra_path: [],
		coverage_threshold: 0,
		consumer_typecheck: false,
		import_graph_depth: 1,
		complexity_threshold: 15,
		function_size_limit: 50,
		mutation_score_threshold: 0,
	},
	security: {
		require_semgrep: true,
		require_osv_scanner: false,
	},
	escalation: {
		security_threshold: 10,
		drift_threshold: 8,
		test_quality_threshold: 8,
		duplication_threshold: 8,
		semantic_threshold: 8,
		security_iterative_threshold: 5,
		dead_import_blocking_threshold: 5,
	},
	flywheel: {
		enabled: true,
		min_sessions: 10,
		auto_apply: false,
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
		if (r.models && typeof r.models === "object") {
			const m = r.models as Record<string, unknown>;
			if (typeof m.spec === "string" && m.spec) config.review.models.spec = m.spec;
			if (typeof m.quality === "string" && m.quality) config.review.models.quality = m.quality;
			if (typeof m.security === "string" && m.security) config.review.models.security = m.security;
			if (typeof m.adversarial === "string" && m.adversarial)
				config.review.models.adversarial = m.adversarial;
		}
	}
	if (raw.plan_eval && typeof raw.plan_eval === "object") {
		const p = raw.plan_eval as Record<string, unknown>;
		if (typeof p.score_threshold === "number") config.plan_eval.score_threshold = p.score_threshold;
		if (typeof p.max_iterations === "number") config.plan_eval.max_iterations = p.max_iterations;
		if (Array.isArray(p.registry_files))
			config.plan_eval.registry_files = p.registry_files.filter(
				(f: unknown) => typeof f === "string",
			);
		if (p.models && typeof p.models === "object") {
			const m = p.models as Record<string, unknown>;
			if (typeof m.generator === "string" && m.generator)
				config.plan_eval.models.generator = m.generator;
			if (typeof m.evaluator === "string" && m.evaluator)
				config.plan_eval.models.evaluator = m.evaluator;
		}
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
		if (typeof g.coverage_threshold === "number")
			config.gates.coverage_threshold = Math.max(0, Math.min(100, g.coverage_threshold));
		if (typeof g.consumer_typecheck === "boolean")
			config.gates.consumer_typecheck = g.consumer_typecheck;
		if (typeof g.import_graph_depth === "number")
			config.gates.import_graph_depth = Math.max(1, Math.min(3, g.import_graph_depth));
		if (typeof g.complexity_threshold === "number")
			config.gates.complexity_threshold = Math.max(1, g.complexity_threshold);
		if (typeof g.function_size_limit === "number")
			config.gates.function_size_limit = Math.max(1, g.function_size_limit);
		if (typeof g.mutation_score_threshold === "number")
			config.gates.mutation_score_threshold = Math.max(
				0,
				Math.min(100, g.mutation_score_threshold),
			);
	}
	if (raw.security && typeof raw.security === "object") {
		const s = raw.security as Record<string, unknown>;
		if (typeof s.require_semgrep === "boolean") config.security.require_semgrep = s.require_semgrep;
		if (typeof s.require_osv_scanner === "boolean")
			config.security.require_osv_scanner = s.require_osv_scanner;
	}
	if (raw.escalation && typeof raw.escalation === "object") {
		const e = raw.escalation as Record<string, unknown>;
		if (typeof e.security_threshold === "number")
			config.escalation.security_threshold = Math.max(1, e.security_threshold);
		if (typeof e.drift_threshold === "number")
			config.escalation.drift_threshold = Math.max(1, e.drift_threshold);
		if (typeof e.test_quality_threshold === "number")
			config.escalation.test_quality_threshold = Math.max(1, e.test_quality_threshold);
		if (typeof e.duplication_threshold === "number")
			config.escalation.duplication_threshold = Math.max(1, e.duplication_threshold);
		if (typeof e.semantic_threshold === "number")
			config.escalation.semantic_threshold = Math.max(1, e.semantic_threshold);
		if (typeof e.security_iterative_threshold === "number")
			config.escalation.security_iterative_threshold = Math.max(1, e.security_iterative_threshold);
		if (typeof e.dead_import_blocking_threshold === "number")
			config.escalation.dead_import_blocking_threshold = Math.max(
				1,
				e.dead_import_blocking_threshold,
			);
	}
	if (raw.flywheel && typeof raw.flywheel === "object") {
		const f = raw.flywheel as Record<string, unknown>;
		if (typeof f.enabled === "boolean") config.flywheel.enabled = f.enabled;
		if (typeof f.min_sessions === "number")
			config.flywheel.min_sessions = Math.max(1, f.min_sessions);
		if (typeof f.auto_apply === "boolean") config.flywheel.auto_apply = f.auto_apply;
	}
}

/** Convert DB KV rows to a nested config object for applyConfigLayer.
 *  Supports 2-level (section.field) and 3-level (section.sub.field) keys. */
function kvRowsToRaw(rows: { key: string; value: string }[]): Record<string, unknown> {
	const raw: Record<string, Record<string, unknown>> = {};
	for (const row of rows) {
		const parts = row.key.split(".");
		if (parts.length < 2) continue;
		const section = parts[0]!;
		if (!raw[section]) raw[section] = {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.value);
		} catch {
			parsed = row.value;
		}
		if (parts.length === 2) {
			raw[section][parts[1]!] = parsed;
		} else if (parts.length === 3) {
			// 3-level: e.g. review.models.spec → { review: { models: { spec: value } } }
			const sub = parts[1]!;
			if (!raw[section][sub] || typeof raw[section][sub] !== "object") {
				raw[section][sub] = {};
			}
			(raw[section][sub] as Record<string, unknown>)[parts[2]!] = parsed;
		}
	}
	return raw;
}

// Process-scoped cache
let _cache: QultConfig | null = null;

/** Load config with layered precedence: defaults → global_configs → project_configs → QULT_* env vars */
export function loadConfig(): QultConfig {
	if (_cache) return _cache;

	const config = structuredClone(DEFAULTS);

	// Layer 1: global_configs (user-level cross-project, replaces preferences.json)
	try {
		const db = getDb();
		const globalRows = db.prepare("SELECT key, value FROM global_configs").all() as {
			key: string;
			value: string;
		}[];
		if (globalRows.length > 0) {
			applyConfigLayer(config, kvRowsToRaw(globalRows));
		}
	} catch {
		/* fail-open */
	}

	// Layer 2: project_configs (project-level, replaces .qult/config.json)
	try {
		const db = getDb();
		const projectId = getProjectId();
		const projectRows = db
			.prepare("SELECT key, value FROM project_configs WHERE project_id = ?")
			.all(projectId) as { key: string; value: string }[];
		if (projectRows.length > 0) {
			applyConfigLayer(config, kvRowsToRaw(projectRows));
		}
	} catch {
		/* fail-open */
	}

	// Layer 3: QULT_* environment variables
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
	const covThreshold = envInt("QULT_COVERAGE_THRESHOLD");
	if (covThreshold !== undefined)
		config.gates.coverage_threshold = Math.max(0, Math.min(100, covThreshold));
	const consumerTcEnv = process.env.QULT_CONSUMER_TYPECHECK;
	if (consumerTcEnv === "1" || consumerTcEnv === "true") config.gates.consumer_typecheck = true;
	else if (consumerTcEnv === "0" || consumerTcEnv === "false")
		config.gates.consumer_typecheck = false;
	const igDepth = envInt("QULT_IMPORT_GRAPH_DEPTH");
	if (igDepth !== undefined) config.gates.import_graph_depth = Math.max(1, Math.min(3, igDepth));
	const complexityThreshold = envInt("QULT_COMPLEXITY_THRESHOLD");
	if (complexityThreshold !== undefined)
		config.gates.complexity_threshold = Math.max(1, complexityThreshold);
	const funcSizeLimit = envInt("QULT_FUNCTION_SIZE_LIMIT");
	if (funcSizeLimit !== undefined) config.gates.function_size_limit = Math.max(1, funcSizeLimit);
	const mutationScore = envInt("QULT_MUTATION_SCORE_THRESHOLD");
	if (mutationScore !== undefined)
		config.gates.mutation_score_threshold = Math.max(0, Math.min(100, mutationScore));
	const secEsc = envInt("QULT_ESCALATION_SECURITY");
	if (secEsc !== undefined) config.escalation.security_threshold = Math.max(1, secEsc);
	const driftEsc = envInt("QULT_ESCALATION_DRIFT");
	if (driftEsc !== undefined) config.escalation.drift_threshold = Math.max(1, driftEsc);
	const tqEsc = envInt("QULT_ESCALATION_TEST_QUALITY");
	if (tqEsc !== undefined) config.escalation.test_quality_threshold = Math.max(1, tqEsc);
	const dupEsc = envInt("QULT_ESCALATION_DUPLICATION");
	if (dupEsc !== undefined) config.escalation.duplication_threshold = Math.max(1, dupEsc);
	const semEsc = envInt("QULT_ESCALATION_SEMANTIC");
	if (semEsc !== undefined) config.escalation.semantic_threshold = Math.max(1, semEsc);
	const secIterEsc = envInt("QULT_ESCALATION_SECURITY_ITERATIVE");
	if (secIterEsc !== undefined)
		config.escalation.security_iterative_threshold = Math.max(1, secIterEsc);
	const deadImportEsc = envInt("QULT_ESCALATION_DEAD_IMPORT_BLOCKING");
	if (deadImportEsc !== undefined)
		config.escalation.dead_import_blocking_threshold = Math.max(1, deadImportEsc);

	// Security env var overrides
	const requireSemgrepEnv = process.env.QULT_REQUIRE_SEMGREP;
	if (requireSemgrepEnv === "1" || requireSemgrepEnv === "true")
		config.security.require_semgrep = true;
	else if (requireSemgrepEnv === "0" || requireSemgrepEnv === "false")
		config.security.require_semgrep = false;
	const requireOsvScannerEnv = process.env.QULT_REQUIRE_OSV_SCANNER;
	if (requireOsvScannerEnv === "1" || requireOsvScannerEnv === "true")
		config.security.require_osv_scanner = true;
	else if (requireOsvScannerEnv === "0" || requireOsvScannerEnv === "false")
		config.security.require_osv_scanner = false;

	// Model env var overrides (non-empty string)
	const envStr = (key: string): string | undefined => {
		const val = process.env[key];
		return val?.trim() ? val.trim() : undefined;
	};
	config.review.models.spec = envStr("QULT_REVIEW_MODEL_SPEC") ?? config.review.models.spec;
	config.review.models.quality =
		envStr("QULT_REVIEW_MODEL_QUALITY") ?? config.review.models.quality;
	config.review.models.security =
		envStr("QULT_REVIEW_MODEL_SECURITY") ?? config.review.models.security;
	config.review.models.adversarial =
		envStr("QULT_REVIEW_MODEL_ADVERSARIAL") ?? config.review.models.adversarial;
	config.plan_eval.models.generator =
		envStr("QULT_PLAN_EVAL_MODEL_GENERATOR") ?? config.plan_eval.models.generator;
	config.plan_eval.models.evaluator =
		envStr("QULT_PLAN_EVAL_MODEL_EVALUATOR") ?? config.plan_eval.models.evaluator;

	// Flywheel env var overrides
	const flywheelEnv = process.env.QULT_FLYWHEEL_ENABLED;
	if (flywheelEnv === "1" || flywheelEnv === "true") config.flywheel.enabled = true;
	else if (flywheelEnv === "0" || flywheelEnv === "false") config.flywheel.enabled = false;
	const flywheelMin = envInt("QULT_FLYWHEEL_MIN_SESSIONS");
	if (flywheelMin !== undefined) config.flywheel.min_sessions = Math.max(1, flywheelMin);
	const flywheelAutoApplyEnv = process.env.QULT_FLYWHEEL_AUTO_APPLY;
	if (flywheelAutoApplyEnv === "1" || flywheelAutoApplyEnv === "true")
		config.flywheel.auto_apply = true;
	else if (flywheelAutoApplyEnv === "0" || flywheelAutoApplyEnv === "false")
		config.flywheel.auto_apply = false;

	_cache = config;
	return config;
}

/** Reset cache (for tests). */
export function resetConfigCache(): void {
	_cache = null;
}
