import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig, resetConfigCache, setConfigKey } from "../config.ts";
import { setProjectRoot } from "../state/paths.ts";

let tmpRoot: string;
const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"QULT_REVIEW_SCORE_THRESHOLD",
	"QULT_REVIEW_MAX_ITERATIONS",
	"QULT_REVIEW_DIMENSION_FLOOR",
	"QULT_REVIEW_LOW_ONLY_PASSES",
	"QULT_REQUIRE_HUMAN_APPROVAL",
	"QULT_REVIEW_MODEL_SECURITY",
	"QULT_REQUIRE_SEMGREP",
];

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "qult-config-"));
	mkdirSync(join(tmpRoot, ".qult"), { recursive: true });
	setProjectRoot(tmpRoot);
	for (const k of ENV_KEYS) {
		SAVED_ENV[k] = process.env[k];
		delete process.env[k];
	}
	resetConfigCache();
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (SAVED_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = SAVED_ENV[k];
	}
	resetConfigCache();
	setProjectRoot(null);
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadConfig defaults", () => {
	it("returns built-in defaults when no config.json exists", () => {
		const cfg = loadConfig();
		expect(cfg.review.score_threshold).toBe(DEFAULTS.review.score_threshold);
		expect(cfg.review.dimension_floor).toBe(DEFAULTS.review.dimension_floor);
		expect(cfg.review.models.security).toBe(DEFAULTS.review.models.security);
	});
});

describe("loadConfig from .qult/config.json", () => {
	it("applies project-level overrides", () => {
		writeFileSync(
			join(tmpRoot, ".qult", "config.json"),
			JSON.stringify({
				review: {
					score_threshold: 35,
					dimension_floor: 5,
					models: { security: "haiku" },
				},
			}),
		);
		const cfg = loadConfig();
		expect(cfg.review.score_threshold).toBe(35);
		expect(cfg.review.dimension_floor).toBe(5);
		expect(cfg.review.models.security).toBe("haiku");
	});

	it("falls back to defaults for unset fields", () => {
		writeFileSync(
			join(tmpRoot, ".qult", "config.json"),
			JSON.stringify({ review: { score_threshold: 25 } }),
		);
		const cfg = loadConfig();
		expect(cfg.review.score_threshold).toBe(25);
		expect(cfg.review.max_iterations).toBe(DEFAULTS.review.max_iterations);
	});

	it("ignores malformed config.json silently", () => {
		writeFileSync(join(tmpRoot, ".qult", "config.json"), "{ not json");
		const cfg = loadConfig();
		expect(cfg.review.score_threshold).toBe(DEFAULTS.review.score_threshold);
	});
});

describe("env overrides", () => {
	it("QULT_REVIEW_SCORE_THRESHOLD overrides config.json", () => {
		writeFileSync(
			join(tmpRoot, ".qult", "config.json"),
			JSON.stringify({ review: { score_threshold: 25 } }),
		);
		process.env.QULT_REVIEW_SCORE_THRESHOLD = "40";
		const cfg = loadConfig();
		expect(cfg.review.score_threshold).toBe(40);
	});

	it("QULT_REQUIRE_HUMAN_APPROVAL=1 enables human approval", () => {
		process.env.QULT_REQUIRE_HUMAN_APPROVAL = "1";
		const cfg = loadConfig();
		expect(cfg.review.require_human_approval).toBe(true);
	});

	it("QULT_REVIEW_MODEL_SECURITY overrides model", () => {
		process.env.QULT_REVIEW_MODEL_SECURITY = "haiku";
		const cfg = loadConfig();
		expect(cfg.review.models.security).toBe("haiku");
	});

	it("clamps dimension_floor to [1, 5]", () => {
		process.env.QULT_REVIEW_DIMENSION_FLOOR = "99";
		const cfg = loadConfig();
		expect(cfg.review.dimension_floor).toBe(5);
	});
});

describe("setConfigKey", () => {
	it("writes a 2-level key to config.json", () => {
		setConfigKey("review.score_threshold", 33);
		resetConfigCache();
		const cfg = loadConfig();
		expect(cfg.review.score_threshold).toBe(33);
	});

	it("writes a 3-level key (model override)", () => {
		setConfigKey("review.models.security", "haiku");
		resetConfigCache();
		const cfg = loadConfig();
		expect(cfg.review.models.security).toBe("haiku");
	});

	it("rejects keys with unsupported depth", () => {
		expect(() => setConfigKey("review", 1)).toThrow();
		expect(() => setConfigKey("review.models.security.extra", 1)).toThrow();
	});
});
