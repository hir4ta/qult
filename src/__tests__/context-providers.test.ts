import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-ctx-providers-test");
const QULT_DIR = join(TEST_DIR, ".qult");
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(QULT_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadContextProviders", () => {
	it("returns null when no config file", async () => {
		const { loadContextProviders } = await import("../state/context-providers.ts");
		expect(loadContextProviders()).toBeNull();
	});

	it("loads providers from config file", async () => {
		writeFileSync(
			join(QULT_DIR, "context-providers.json"),
			JSON.stringify({
				ci_status: { command: "echo ok", timeout: 3000, inject_on: "session_start" },
			}),
		);
		const { loadContextProviders } = await import("../state/context-providers.ts");
		const providers = loadContextProviders();
		expect(providers).not.toBeNull();
		expect(providers!.ci_status).toBeDefined();
		expect(providers!.ci_status!.command).toBe("echo ok");
	});
});

describe("runProviders", () => {
	it("executes matching providers and returns results", async () => {
		writeFileSync(
			join(QULT_DIR, "context-providers.json"),
			JSON.stringify({
				ci_status: { command: "echo 'CI: passing'", timeout: 3000, inject_on: "session_start" },
				deploy: { command: "echo 'Deploy: live'", timeout: 3000, inject_on: "session_start" },
			}),
		);
		const { runProviders } = await import("../state/context-providers.ts");
		const results = runProviders("session_start");
		expect(results).toHaveLength(2);
		expect(results.some((r) => r.includes("CI: passing"))).toBe(true);
		expect(results.some((r) => r.includes("Deploy: live"))).toBe(true);
	});

	it("skips providers with different inject_on", async () => {
		writeFileSync(
			join(QULT_DIR, "context-providers.json"),
			JSON.stringify({
				ci_status: { command: "echo 'CI'", timeout: 3000, inject_on: "session_start" },
				on_commit_hook: { command: "echo 'commit'", timeout: 3000, inject_on: "on_commit" },
			}),
		);
		const { runProviders } = await import("../state/context-providers.ts");
		const results = runProviders("session_start");
		expect(results).toHaveLength(1);
		expect(results[0]).toContain("CI");
	});

	it("returns empty array when no config", async () => {
		const { runProviders } = await import("../state/context-providers.ts");
		expect(runProviders("session_start")).toHaveLength(0);
	});

	it("handles failing provider gracefully (fail-open)", async () => {
		writeFileSync(
			join(QULT_DIR, "context-providers.json"),
			JSON.stringify({
				broken: { command: "exit 1", timeout: 3000, inject_on: "session_start" },
				working: { command: "echo 'ok'", timeout: 3000, inject_on: "session_start" },
			}),
		);
		const { runProviders } = await import("../state/context-providers.ts");
		const results = runProviders("session_start");
		expect(results).toHaveLength(1);
		expect(results[0]).toContain("ok");
	});
});
