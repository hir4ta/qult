import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** User-configurable settings in .qult/config.json */
export interface QultConfig {
	review: {
		score_threshold: number;
		max_iterations: number;
		required_changed_files: number;
	};
	gates: {
		output_max_chars: number;
		default_timeout: number;
	};
}

const DEFAULTS: QultConfig = {
	review: {
		score_threshold: 12,
		max_iterations: 3,
		required_changed_files: 5,
	},
	gates: {
		output_max_chars: 2000,
		default_timeout: 10000,
	},
};

// Process-scoped cache
let _cache: QultConfig | null = null;

/** Load config with layered precedence: defaults → .qult/config.json → QULT_* env vars */
export function loadConfig(): QultConfig {
	if (_cache) return _cache;

	const config = structuredClone(DEFAULTS);

	// Layer 1: .qult/config.json
	try {
		const configPath = join(process.cwd(), ".qult", "config.json");
		if (existsSync(configPath)) {
			const raw = JSON.parse(readFileSync(configPath, "utf-8"));
			if (raw.review) {
				if (typeof raw.review.score_threshold === "number")
					config.review.score_threshold = raw.review.score_threshold;
				if (typeof raw.review.max_iterations === "number")
					config.review.max_iterations = raw.review.max_iterations;
				if (typeof raw.review.required_changed_files === "number")
					config.review.required_changed_files = raw.review.required_changed_files;
			}
			if (raw.gates) {
				if (typeof raw.gates.output_max_chars === "number")
					config.gates.output_max_chars = raw.gates.output_max_chars;
				if (typeof raw.gates.default_timeout === "number")
					config.gates.default_timeout = raw.gates.default_timeout;
			}
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
	config.gates.output_max_chars = envInt("QULT_GATE_OUTPUT_MAX") ?? config.gates.output_max_chars;
	config.gates.default_timeout =
		envInt("QULT_GATE_DEFAULT_TIMEOUT") ?? config.gates.default_timeout;

	_cache = config;
	return config;
}

/** Reset cache (for tests). */
export function resetConfigCache(): void {
	_cache = null;
}
