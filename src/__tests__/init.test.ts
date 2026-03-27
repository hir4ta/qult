import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_HOME = join(import.meta.dirname, ".tmp-init-test-home");
const TEST_PROJECT = join(import.meta.dirname, ".tmp-init-test-project");
const originalCwd = process.cwd();
const originalHome = process.env.HOME;

beforeEach(() => {
	mkdirSync(TEST_HOME, { recursive: true });
	mkdirSync(TEST_PROJECT, { recursive: true });
	process.env.HOME = TEST_HOME;
	process.chdir(TEST_PROJECT);

	writeFileSync(join(TEST_PROJECT, "biome.json"), "{}");
	writeFileSync(join(TEST_PROJECT, "tsconfig.json"), "{}");
	writeFileSync(
		join(TEST_PROJECT, "package.json"),
		JSON.stringify({ devDependencies: { vitest: "^3" } }),
	);
});

afterEach(() => {
	process.env.HOME = originalHome;
	process.chdir(originalCwd);
	rmSync(TEST_HOME, { recursive: true, force: true });
	rmSync(TEST_PROJECT, { recursive: true, force: true });
});

describe("qult init", () => {
	it("writes hooks in matcher+hooks format to settings.json", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(false);

		const settingsPath = join(TEST_HOME, ".claude", "settings.json");
		expect(existsSync(settingsPath)).toBe(true);

		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(settings.hooks.PostToolUse).toBeDefined();
		expect(settings.hooks.PreToolUse).toBeDefined();
		expect(settings.hooks.Stop).toBeDefined();
		expect(settings.hooks.PermissionRequest).toBeDefined();

		// PostToolUse/PreToolUse have per-tool matchers (Edit, Write, Bash) to avoid unnecessary process spawns
		const postToolMatchers = settings.hooks.PostToolUse.map(
			(e: Record<string, unknown>) => e.matcher,
		);
		expect(postToolMatchers).toContain("Edit");
		expect(postToolMatchers).toContain("Write");
		expect(postToolMatchers).toContain("Bash");

		const preToolMatchers = settings.hooks.PreToolUse.map(
			(e: Record<string, unknown>) => e.matcher,
		);
		expect(preToolMatchers).toContain("Edit");
		expect(preToolMatchers).toContain("Write");
		expect(preToolMatchers).toContain("Bash");

		// Each entry has matcher + hooks array
		const postTool = settings.hooks.PostToolUse[0];
		expect(Array.isArray(postTool.hooks)).toBe(true);
		expect(postTool.hooks[0].command).toContain("qult hook post-tool");

		// PermissionRequest has ExitPlanMode matcher
		const permHook = settings.hooks.PermissionRequest[0];
		expect(permHook.matcher).toBe("ExitPlanMode");
		expect(permHook.hooks[0].command).toContain("qult hook permission-request");
	});

	it("creates .qult/gates.json with detected gates", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(false);

		const gatesPath = join(TEST_PROJECT, ".qult", "gates.json");
		expect(existsSync(gatesPath)).toBe(true);

		const gates = JSON.parse(readFileSync(gatesPath, "utf-8"));
		expect(gates.on_write?.lint?.command).toContain("biome");
		expect(gates.on_write?.typecheck?.command).toContain("tsc");
	});

	it("writes skill file for /qult:review", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(false);

		const skillPath = join(TEST_HOME, ".claude", "skills", "qult-review", "SKILL.md");
		expect(existsSync(skillPath)).toBe(true);

		const content = readFileSync(skillPath, "utf-8");
		expect(content).toContain("review");
		expect(content).toContain("correctness");
		expect(content).toContain("security");
		expect(content).toContain("Judge");
	});

	it("writes agent file for qult-reviewer", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(false);

		const agentPath = join(TEST_HOME, ".claude", "agents", "qult-reviewer.md");
		expect(existsSync(agentPath)).toBe(true);

		const content = readFileSync(agentPath, "utf-8");
		expect(content).toContain("reviewer");
	});

	it("writes quality rules", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(false);

		const rulesPath = join(TEST_HOME, ".claude", "rules", "qult-quality.md");
		expect(existsSync(rulesPath)).toBe(true);

		const content = readFileSync(rulesPath, "utf-8");
		expect(content.split("\n").length).toBeLessThanOrEqual(30);
	});

	it("registers project in ~/.qult/registry.json", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(false);

		const registryPath = join(TEST_HOME, ".qult", "registry.json");
		expect(existsSync(registryPath)).toBe(true);

		const entries = JSON.parse(readFileSync(registryPath, "utf-8"));
		expect(entries).toHaveLength(1);
		expect(entries[0].path).toBe(TEST_PROJECT);
		expect(entries[0].registered_at).toBeDefined();
	});

	it("updates existing registry entry on re-init", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(false);
		await runInit(true);

		const registryPath = join(TEST_HOME, ".qult", "registry.json");
		const entries = JSON.parse(readFileSync(registryPath, "utf-8"));
		expect(entries).toHaveLength(1);
	});

	it("does not overwrite existing hooks without --force", async () => {
		const claudeDir = join(TEST_HOME, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		// Pre-create settings in NEW format with existing qult hook
		writeFileSync(
			join(claudeDir, "settings.json"),
			JSON.stringify({
				hooks: {
					PostToolUse: [
						{
							matcher: "Edit",
							hooks: [{ type: "command", command: "qult hook post-tool", timeout: 5000 }],
						},
					],
				},
			}),
		);

		const { runInit } = await import("../init.ts");
		await runInit(false);

		const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8"));
		// Should replace old qult entries with new ones (Edit, Write, Bash matchers)
		const qultEntries = settings.hooks.PostToolUse.filter((e: Record<string, unknown>) =>
			JSON.stringify(e).includes("qult hook"),
		);
		expect(qultEntries).toHaveLength(3);
	});
});
