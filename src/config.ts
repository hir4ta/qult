import { existsSync, readFileSync } from "node:fs";
import { configJsonPath } from "./state/paths.ts";

/** User-configurable settings */
export interface QultConfig {
	review: {
		score_threshold: number;
		max_iterations: number;
		required_changed_files: number;
		dimension_floor: number;
		require_human_approval: boolean;
		/** If true, when all review findings are severity `low` only, accept the review as PASS without further iteration. */
		low_only_passes: boolean;
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
		/** Additional PATH directories for gate command execution */
		extra_path: string[];
		/** Minimum test coverage percentage to pass. 0 = disabled (opt-in). */
		coverage_threshold: number;
		/** Import graph traversal depth for consumer detection (1-3). Used by get_impact_analysis MCP tool. */
		import_graph_depth: number;
	};
	/** Security enforcement */
	security: {
		/** Require Semgrep to be installed. Used by security-reviewer for SAST. */
		require_semgrep: boolean;
	};
}

export const DEFAULTS: QultConfig = {
	review: {
		score_threshold: 30,
		max_iterations: 3,
		required_changed_files: 5,
		dimension_floor: 4,
		require_human_approval: false,
		low_only_passes: false,
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
		extra_path: [],
		coverage_threshold: 0,
		import_graph_depth: 1,
	},
	security: {
		require_semgrep: true,
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
		if (typeof r.low_only_passes === "boolean") config.review.low_only_passes = r.low_only_passes;
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
		if (Array.isArray(g.extra_path))
			config.gates.extra_path = g.extra_path.filter(
				(p: unknown) => typeof p === "string" && p.trim().length > 0,
			);
		if (typeof g.coverage_threshold === "number")
			config.gates.coverage_threshold = Math.max(0, Math.min(100, g.coverage_threshold));
		if (typeof g.import_graph_depth === "number")
			config.gates.import_graph_depth = Math.max(1, Math.min(3, g.import_graph_depth));
	}
	if (raw.security && typeof raw.security === "object") {
		const s = raw.security as Record<string, unknown>;
		if (typeof s.require_semgrep === "boolean") config.security.require_semgrep = s.require_semgrep;
	}
}

/** Read raw config object from .qult/config.json (returns {} if missing/malformed). */
function readConfigJson(): Record<string, unknown> {
	try {
		const path = configJsonPath();
		if (!existsSync(path)) return {};
		const txt = readFileSync(path, "utf8");
		const parsed = JSON.parse(txt);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

// Process-scoped cache
let _cache: QultConfig | null = null;

/** Load config with precedence: defaults → .qult/config.json → QULT_* env vars (no global, no SQLite). */
export function loadConfig(): QultConfig {
	if (_cache) return _cache;

	const config = structuredClone(DEFAULTS);

	// Layer 1: project-local .qult/config.json
	const raw = readConfigJson();
	if (Object.keys(raw).length > 0) {
		applyConfigLayer(config, raw);
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
	const lowOnlyPassesEnv = process.env.QULT_REVIEW_LOW_ONLY_PASSES;
	if (lowOnlyPassesEnv === "1" || lowOnlyPassesEnv === "true") config.review.low_only_passes = true;
	else if (lowOnlyPassesEnv === "0" || lowOnlyPassesEnv === "false")
		config.review.low_only_passes = false;
	const covThreshold = envInt("QULT_COVERAGE_THRESHOLD");
	if (covThreshold !== undefined)
		config.gates.coverage_threshold = Math.max(0, Math.min(100, covThreshold));
	const igDepth = envInt("QULT_IMPORT_GRAPH_DEPTH");
	if (igDepth !== undefined) config.gates.import_graph_depth = Math.max(1, Math.min(3, igDepth));

	// Security env var overrides
	const requireSemgrepEnv = process.env.QULT_REQUIRE_SEMGREP;
	if (requireSemgrepEnv === "1" || requireSemgrepEnv === "true")
		config.security.require_semgrep = true;
	else if (requireSemgrepEnv === "0" || requireSemgrepEnv === "false")
		config.security.require_semgrep = false;

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

	_cache = config;
	return config;
}

/** Reset cache. Call between tests or when env changes. */
export function resetConfigCache(): void {
	_cache = null;
}

/** Set a single config key in `.qult/config.json` (dot-path supported, depth 2 or 3). */
export function setConfigKey(key: string, value: number | string | boolean): void {
	const parts = key.split(".");
	if (parts.length < 2 || parts.length > 3) {
		throw new Error(`unsupported config key depth: ${key}`);
	}
	const raw = readConfigJson();
	const top = parts[0]!;
	if (!raw[top] || typeof raw[top] !== "object" || Array.isArray(raw[top])) {
		raw[top] = {};
	}
	if (parts.length === 2) {
		(raw[top] as Record<string, unknown>)[parts[1]!] = value;
	} else {
		const sub = parts[1]!;
		const topObj = raw[top] as Record<string, unknown>;
		if (!topObj[sub] || typeof topObj[sub] !== "object" || Array.isArray(topObj[sub])) {
			topObj[sub] = {};
		}
		(topObj[sub] as Record<string, unknown>)[parts[2]!] = value;
	}
	const path = configJsonPath();
	// Ensure .qult/ directory exists.
	const { mkdirSync, writeFileSync, renameSync } = require("node:fs") as typeof import("node:fs");
	mkdirSync(path.replace(/\/[^/]+$/u, ""), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}
