import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readConfigOrThrow,
	readEnabledIntegrations,
	updateEnabledIntegrations,
} from "../state/config-io.ts";
import { setProjectRoot } from "../state/paths.ts";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "qult-config-io-"));
	mkdirSync(resolve(tmpRoot, ".qult"), { recursive: true });
	setProjectRoot(tmpRoot);
});
afterEach(() => {
	setProjectRoot(null);
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("readConfigOrThrow", () => {
	it("returns {} when the file is missing", () => {
		expect(readConfigOrThrow()).toEqual({});
	});

	it("throws when the file contains malformed JSON (does NOT silently overwrite)", () => {
		writeFileSync(resolve(tmpRoot, ".qult/config.json"), "{invalid json,,}");
		expect(() => readConfigOrThrow()).toThrowError(/malformed/);
	});

	it("throws when the top-level value is not a plain object", () => {
		writeFileSync(resolve(tmpRoot, ".qult/config.json"), '["arr"]');
		expect(() => readConfigOrThrow()).toThrowError(/not an object/);
	});
});

describe("updateEnabledIntegrations", () => {
	it("set mode replaces the list while preserving other config keys", () => {
		writeFileSync(
			resolve(tmpRoot, ".qult/config.json"),
			JSON.stringify({ review: { score_threshold: 35 }, gates: { default_timeout: 5000 } }),
		);
		updateEnabledIntegrations(["claude"], "set");
		const after = JSON.parse(readFileSync(resolve(tmpRoot, ".qult/config.json"), "utf8"));
		expect(after.review.score_threshold).toBe(35);
		expect(after.gates.default_timeout).toBe(5000);
		expect(after.integrations.enabled).toEqual(["claude"]);
	});

	it("append mode adds new keys without duplicates", () => {
		writeFileSync(
			resolve(tmpRoot, ".qult/config.json"),
			JSON.stringify({ integrations: { enabled: ["claude"] } }),
		);
		updateEnabledIntegrations(["cursor"], "append");
		updateEnabledIntegrations(["cursor"], "append"); // already present
		const after = JSON.parse(readFileSync(resolve(tmpRoot, ".qult/config.json"), "utf8"));
		expect(after.integrations.enabled).toEqual(["claude", "cursor"]);
	});

	it("refuses to write when existing config is corrupted", () => {
		writeFileSync(resolve(tmpRoot, ".qult/config.json"), "{not json");
		expect(() => updateEnabledIntegrations(["claude"], "set")).toThrowError(/malformed/);
		// And the corrupt file is left untouched.
		expect(readFileSync(resolve(tmpRoot, ".qult/config.json"), "utf8")).toBe("{not json");
	});
});

describe("readEnabledIntegrations", () => {
	it("returns [] when the config does not exist", () => {
		expect(readEnabledIntegrations()).toEqual([]);
	});

	it("returns the enabled list when present", () => {
		writeFileSync(
			resolve(tmpRoot, ".qult/config.json"),
			JSON.stringify({ integrations: { enabled: ["claude", "cursor"] } }),
		);
		expect(readEnabledIntegrations()).toEqual(["claude", "cursor"]);
	});

	it("returns [] silently when config is corrupted (read path is non-throwing)", () => {
		writeFileSync(resolve(tmpRoot, ".qult/config.json"), "{not json");
		expect(readEnabledIntegrations()).toEqual([]);
	});
});
