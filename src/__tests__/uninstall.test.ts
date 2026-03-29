import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUninstall } from "../uninstall.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-uninstall-test");
const FAKE_HOME = join(TEST_DIR, "home");
const PROJECT_DIR = join(TEST_DIR, "project");
const originalCwd = process.cwd();
const originalHome = process.env.HOME;

beforeEach(() => {
	mkdirSync(join(FAKE_HOME, ".claude", "skills", "qult-review"), { recursive: true });
	mkdirSync(join(FAKE_HOME, ".claude", "agents"), { recursive: true });
	mkdirSync(join(FAKE_HOME, ".claude", "rules"), { recursive: true });
	mkdirSync(join(PROJECT_DIR, ".qult", ".state"), { recursive: true });
	mkdirSync(join(FAKE_HOME, ".qult"), { recursive: true });

	process.env.HOME = FAKE_HOME;
	process.chdir(PROJECT_DIR);

	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	process.env.HOME = originalHome;
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("uninstall", () => {
	it("shows targets in dry-run mode (no --yes)", async () => {
		// Create some qult files
		writeFileSync(join(FAKE_HOME, ".claude", "agents", "qult-reviewer.md"), "test");
		writeFileSync(join(FAKE_HOME, ".claude", "rules", "qult-quality.md"), "test");
		writeFileSync(join(FAKE_HOME, ".claude", "skills", "qult-review", "SKILL.md"), "test");

		await runUninstall(false);
		const logs = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).join("\n");
		expect(logs).toContain("qult-reviewer.md");
		expect(logs).toContain("--yes");
	});

	it("removes qult hooks from settings.json", async () => {
		const settings = {
			hooks: {
				PostToolUse: [
					{ matcher: "Edit", hooks: [{ type: "command", command: "qult hook post-tool" }] },
					{ matcher: "Edit", hooks: [{ type: "command", command: "other-tool hook" }] },
				],
				SessionStart: [
					{ matcher: "", hooks: [{ type: "command", command: "qult hook session-start" }] },
				],
			},
		};
		writeFileSync(join(FAKE_HOME, ".claude", "settings.json"), JSON.stringify(settings));

		await runUninstall(true);

		const updated = JSON.parse(readFileSync(join(FAKE_HOME, ".claude", "settings.json"), "utf-8"));
		// Non-qult hooks preserved
		expect(updated.hooks.PostToolUse).toHaveLength(1);
		expect(JSON.stringify(updated.hooks.PostToolUse[0])).toContain("other-tool");
		// Empty event removed
		expect(updated.hooks.SessionStart).toBeUndefined();
	});

	it("removes skill directories", async () => {
		writeFileSync(join(FAKE_HOME, ".claude", "skills", "qult-review", "SKILL.md"), "test");

		await runUninstall(true);

		expect(existsSync(join(FAKE_HOME, ".claude", "skills", "qult-review"))).toBe(false);
	});

	it("removes .qult/.state/", async () => {
		writeFileSync(join(PROJECT_DIR, ".qult", ".state", "pending-fixes.json"), "[]");

		await runUninstall(true);

		expect(existsSync(join(PROJECT_DIR, ".qult", ".state"))).toBe(false);
	});

	it("removes project from registry", async () => {
		const registry = [
			{ path: PROJECT_DIR, registered_at: "2025-01-01" },
			{ path: "/other/project", registered_at: "2025-01-01" },
		];
		writeFileSync(join(FAKE_HOME, ".qult", "registry.json"), JSON.stringify(registry));

		await runUninstall(true);

		const updated = JSON.parse(readFileSync(join(FAKE_HOME, ".qult", "registry.json"), "utf-8"));
		expect(updated).toHaveLength(1);
		expect(updated[0].path).toBe("/other/project");
	});
});
