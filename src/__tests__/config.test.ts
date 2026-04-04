import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../config.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-config-test");
const originalCwd = process.cwd();

beforeEach(() => {
	resetConfigCache();
	mkdirSync(join(TEST_DIR, ".qult"), { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
	// Clean env vars
	delete process.env.QULT_REVIEW_SCORE_THRESHOLD;
	delete process.env.QULT_REVIEW_MAX_ITERATIONS;
	delete process.env.QULT_REVIEW_REQUIRED_FILES;
	delete process.env.QULT_GATE_OUTPUT_MAX;
	delete process.env.QULT_GATE_DEFAULT_TIMEOUT;
	delete process.env.CLAUDE_PLUGIN_DATA;
});

describe("loadConfig", () => {
	it("returns defaults when no config file exists", () => {
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(24);
		expect(config.review.max_iterations).toBe(3);
		expect(config.review.required_changed_files).toBe(5);
		expect(config.gates.output_max_chars).toBe(2000);
		expect(config.gates.default_timeout).toBe(10000);
	});

	it("reads from .qult/config.json", () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "config.json"),
			JSON.stringify({
				review: { score_threshold: 10, max_iterations: 5 },
				gates: { output_max_chars: 3000 },
			}),
		);
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(10);
		expect(config.review.max_iterations).toBe(5);
		// Unset values keep defaults
		expect(config.review.required_changed_files).toBe(5);
		expect(config.gates.output_max_chars).toBe(3000);
		expect(config.gates.default_timeout).toBe(10000);
	});

	it("env vars override config file", () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "config.json"),
			JSON.stringify({
				review: { score_threshold: 10 },
			}),
		);
		process.env.QULT_REVIEW_SCORE_THRESHOLD = "14";
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(14);
	});

	it("ignores invalid env var values", () => {
		process.env.QULT_REVIEW_SCORE_THRESHOLD = "not-a-number";
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(24); // default
	});

	it("handles corrupt config file gracefully", () => {
		writeFileSync(join(TEST_DIR, ".qult", "config.json"), "not json");
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(24); // default
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
		process.env.QULT_GATE_OUTPUT_MAX = "1500";
		process.env.QULT_GATE_DEFAULT_TIMEOUT = "5000";
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(9);
		expect(config.review.max_iterations).toBe(2);
		expect(config.review.required_changed_files).toBe(3);
		expect(config.gates.output_max_chars).toBe(1500);
		expect(config.gates.default_timeout).toBe(5000);
	});
});

describe("CLAUDE_PLUGIN_DATA layer", () => {
	it("reads preferences.json from CLAUDE_PLUGIN_DATA", () => {
		const pluginDataDir = join(TEST_DIR, "plugin-data");
		mkdirSync(pluginDataDir, { recursive: true });
		writeFileSync(
			join(pluginDataDir, "preferences.json"),
			JSON.stringify({ review: { score_threshold: 10 } }),
		);
		process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(10);
	});

	it("project config overrides CLAUDE_PLUGIN_DATA", () => {
		const pluginDataDir = join(TEST_DIR, "plugin-data");
		mkdirSync(pluginDataDir, { recursive: true });
		writeFileSync(
			join(pluginDataDir, "preferences.json"),
			JSON.stringify({ review: { score_threshold: 10 } }),
		);
		writeFileSync(
			join(TEST_DIR, ".qult", "config.json"),
			JSON.stringify({ review: { score_threshold: 14 } }),
		);
		process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(14);
	});

	it("env vars override CLAUDE_PLUGIN_DATA", () => {
		const pluginDataDir = join(TEST_DIR, "plugin-data");
		mkdirSync(pluginDataDir, { recursive: true });
		writeFileSync(
			join(pluginDataDir, "preferences.json"),
			JSON.stringify({ review: { score_threshold: 10 } }),
		);
		process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
		process.env.QULT_REVIEW_SCORE_THRESHOLD = "15";
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(15);
	});

	it("skips when CLAUDE_PLUGIN_DATA is not set", () => {
		delete process.env.CLAUDE_PLUGIN_DATA;
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(24); // default
	});

	it("skips when preferences.json is missing", () => {
		const pluginDataDir = join(TEST_DIR, "plugin-data");
		mkdirSync(pluginDataDir, { recursive: true });
		// no preferences.json
		process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(24); // default
	});

	it("skips when preferences.json is corrupt", () => {
		const pluginDataDir = join(TEST_DIR, "plugin-data");
		mkdirSync(pluginDataDir, { recursive: true });
		writeFileSync(join(pluginDataDir, "preferences.json"), "not json");
		process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
		const config = loadConfig();
		expect(config.review.score_threshold).toBe(24); // default
	});
});
