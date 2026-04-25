/**
 * Wave 1 smoke test — verifies that the Node-target pieces wire up:
 *  - state/fs atomicWrite + readJson roundtrip and ENOENT fallback
 *  - detector/network exposes isNetworkAvailable returning a boolean
 *  - config exposes integrations/templates fields with defaults
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig, resetConfigCache } from "../config.ts";
import { isNetworkAvailable } from "../detector/network.ts";
import { atomicWrite, readJson, writeJson } from "../state/fs.ts";
import { setProjectRoot } from "../state/paths.ts";

let tmpRoot: string;

beforeAll(() => {
	tmpRoot = mkdtempSync(resolve(tmpdir(), "qult-wave01-"));
	setProjectRoot(tmpRoot);
	resetConfigCache();
});

afterAll(() => {
	setProjectRoot(null);
	resetConfigCache();
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("state/fs Node port", () => {
	it("atomicWrite + readJson roundtrip", () => {
		const path = resolve(tmpRoot, ".qult/state/_smoke.json");
		writeJson(path, { schema_version: 1, value: 42 });
		const got = readJson<{ schema_version: 1; value: number }>(path, 1);
		expect(got?.value).toBe(42);
	});

	it("readJson returns null when the file is missing (ENOENT fallback)", () => {
		const path = resolve(tmpRoot, ".qult/state/_missing.json");
		expect(readJson<{ schema_version: 1 }>(path, 1)).toBeNull();
	});

	it("atomicWrite leaves no .tmp sidecar on success", () => {
		const path = resolve(tmpRoot, ".qult/state/_atomic.json");
		atomicWrite(path, '{"schema_version":1}\n');
		// The .tmp suffix should not exist after rename.
		expect(readJson<{ schema_version: 1 }>(`${path}.tmp`, 1)).toBeNull();
	});
});

describe("detector/network", () => {
	it("isNetworkAvailable returns a boolean within timeout", async () => {
		const result = await isNetworkAvailable(50);
		expect(typeof result).toBe("boolean");
	});
});

describe("config integrations/templates defaults", () => {
	it("DEFAULTS exposes integrations.enabled and templates.dir undefined", () => {
		expect(DEFAULTS.integrations.enabled).toEqual([]);
		expect(DEFAULTS.templates.dir).toBeUndefined();
	});

	it("loadConfig surfaces integrations/templates after .qult/config.json layer", () => {
		writeJson(resolve(tmpRoot, ".qult/config.json"), {
			integrations: { enabled: ["claude", "codex"] },
			templates: { dir: "./qult.templates" },
		});
		resetConfigCache();
		const cfg = loadConfig();
		expect(cfg.integrations.enabled).toEqual(["claude", "codex"]);
		expect(cfg.templates.dir).toBe("./qult.templates");
	});
});
