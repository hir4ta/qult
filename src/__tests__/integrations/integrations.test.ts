import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenerationContext } from "../../integrations/base.ts";
import { assertConfinedToProject } from "../../integrations/base.ts";
import { ClaudeIntegration } from "../../integrations/claude.ts";
import { CodexIntegration } from "../../integrations/codex.ts";
import { CursorIntegration } from "../../integrations/cursor.ts";
import { GeminiIntegration } from "../../integrations/gemini.ts";

const TEMPLATE_ROOT = resolve(__dirname, "../../templates/bundled");

let projectRoot: string;

function ctx(): GenerationContext {
	return {
		projectRoot,
		templateRoot: TEMPLATE_ROOT,
		vars: { QULT_VERSION: "1.1.0" },
		force: true,
		interactive: false,
	};
}

beforeEach(() => {
	projectRoot = mkdtempSync(join(tmpdir(), "qult-int-"));
});
afterEach(() => {
	rmSync(projectRoot, { recursive: true, force: true });
});

describe("assertConfinedToProject", () => {
	it("rejects paths outside the project root", () => {
		expect(() => assertConfinedToProject("/etc/passwd", projectRoot)).toThrow(/path escape/);
	});
	it("accepts paths inside the project root", () => {
		expect(() => assertConfinedToProject(join(projectRoot, "x.json"), projectRoot)).not.toThrow();
	});
});

describe("ClaudeIntegration.detect (hardened)", () => {
	it("returns false when package.json has non-object dependencies", () => {
		writeFileSync(
			join(projectRoot, "package.json"),
			JSON.stringify({ dependencies: "not-an-object", devDependencies: 42 }),
		);
		expect(ClaudeIntegration.detect(projectRoot)).toBe(false);
	});

	it("returns false when package.json top-level is an array (malformed)", () => {
		writeFileSync(join(projectRoot, "package.json"), JSON.stringify(["not", "an", "object"]));
		expect(ClaudeIntegration.detect(projectRoot)).toBe(false);
	});

	it("detects @anthropic-ai/sdk in devDependencies", () => {
		writeFileSync(
			join(projectRoot, "package.json"),
			JSON.stringify({ devDependencies: { "@anthropic-ai/sdk": "^1.0" } }),
		);
		expect(ClaudeIntegration.detect(projectRoot)).toBe(true);
	});
});

describe("ClaudeIntegration", () => {
	it("writes commands, CLAUDE.md, and .mcp.json", async () => {
		await ClaudeIntegration.generateConfigFiles(ctx());
		await ClaudeIntegration.registerMcpServer(ctx());
		expect(existsSync(join(projectRoot, ".claude/skills/qult-spec/SKILL.md"))).toBe(true);
		expect(existsSync(join(projectRoot, "CLAUDE.md"))).toBe(true);
		const mcp = JSON.parse(readFileSync(join(projectRoot, ".mcp.json"), "utf8"));
		expect(mcp.mcpServers.qult.command).toBe("npx");
		expect(mcp.mcpServers.qult.args).toEqual(["-y", "@hir4ta/qult", "mcp"]);
	});

	it("registerMcpServer is idempotent and preserves other servers", async () => {
		writeFileSync(
			join(projectRoot, ".mcp.json"),
			JSON.stringify({ mcpServers: { other: { command: "node" } } }),
		);
		await ClaudeIntegration.registerMcpServer(ctx());
		await ClaudeIntegration.registerMcpServer(ctx());
		const mcp = JSON.parse(readFileSync(join(projectRoot, ".mcp.json"), "utf8"));
		expect(mcp.mcpServers.other.command).toBe("node");
		expect(mcp.mcpServers.qult.command).toBe("npx");
	});
});

describe("CodexIntegration", () => {
	it("writes [mcp_servers.qult] block to ~/.codex/config.toml (env-overridden in test)", async () => {
		const codexCfg = join(projectRoot, "fake-home/.codex/config.toml");
		const original = process.env.QULT_CODEX_CONFIG_PATH;
		process.env.QULT_CODEX_CONFIG_PATH = codexCfg;
		try {
			await CodexIntegration.registerMcpServer(ctx());
			const toml = readFileSync(codexCfg, "utf8");
			expect(toml).toContain("@qult-mcp-begin");
			expect(toml).toContain("[mcp_servers.qult]");
			expect(toml).toContain('command = "npx"');
		} finally {
			if (original === undefined) delete process.env.QULT_CODEX_CONFIG_PATH;
			else process.env.QULT_CODEX_CONFIG_PATH = original;
		}
	});

	it("replaces existing block in place (idempotent)", async () => {
		const codexCfg = join(projectRoot, "fake-home/.codex/config.toml");
		const original = process.env.QULT_CODEX_CONFIG_PATH;
		process.env.QULT_CODEX_CONFIG_PATH = codexCfg;
		try {
			await CodexIntegration.registerMcpServer(ctx());
			await CodexIntegration.registerMcpServer(ctx());
			const toml = readFileSync(codexCfg, "utf8");
			expect(toml.match(/@qult-mcp-begin/g)).toHaveLength(1);
		} finally {
			if (original === undefined) delete process.env.QULT_CODEX_CONFIG_PATH;
			else process.env.QULT_CODEX_CONFIG_PATH = original;
		}
	});

	it("writes per-command skills to .agents/skills/qult-<cmd>/SKILL.md", async () => {
		await CodexIntegration.generateConfigFiles(ctx());
		expect(existsSync(join(projectRoot, ".agents/skills/qult-spec/SKILL.md"))).toBe(true);
		expect(existsSync(join(projectRoot, ".agents/skills/qult-wave-start/SKILL.md"))).toBe(true);
		const spec = readFileSync(join(projectRoot, ".agents/skills/qult-spec/SKILL.md"), "utf8");
		expect(spec).toMatch(/^---\nname: qult-spec\ndescription:/);
	});
});

describe("CursorIntegration", () => {
	it("writes .cursor/rules/qult.mdc + per-command skills + .cursor/mcp.json", async () => {
		await CursorIntegration.generateConfigFiles(ctx());
		await CursorIntegration.registerMcpServer(ctx());

		const mdc = readFileSync(join(projectRoot, ".cursor/rules/qult.mdc"), "utf8");
		expect(mdc.startsWith("---\n")).toBe(true);
		expect(mdc).toContain("alwaysApply: true");
		expect(mdc).toContain("qult Workflow");

		expect(existsSync(join(projectRoot, ".cursor/skills/qult-spec/SKILL.md"))).toBe(true);
		const skill = readFileSync(join(projectRoot, ".cursor/skills/qult-spec/SKILL.md"), "utf8");
		expect(skill).toMatch(/^---\nname: qult-spec\ndescription:/);

		const mcp = JSON.parse(readFileSync(join(projectRoot, ".cursor/mcp.json"), "utf8"));
		expect(mcp.mcpServers.qult.type).toBe("stdio");
		expect(mcp.mcpServers.qult.args).toEqual(["-y", "@hir4ta/qult", "mcp"]);
	});
});

describe("GeminiIntegration", () => {
	it("writes .gemini/commands/*.toml + .gemini/skills/* + GEMINI.md + .gemini/settings.json", async () => {
		await GeminiIntegration.generateConfigFiles(ctx());
		await GeminiIntegration.registerMcpServer(ctx());
		expect(existsSync(join(projectRoot, ".gemini/commands/qult-spec.toml"))).toBe(true);
		expect(existsSync(join(projectRoot, ".gemini/skills/qult-spec/SKILL.md"))).toBe(true);
		expect(existsSync(join(projectRoot, "GEMINI.md"))).toBe(true);
		const settings = JSON.parse(readFileSync(join(projectRoot, ".gemini/settings.json"), "utf8"));
		expect(settings.mcpServers.qult.command).toBe("npx");
		const toml = readFileSync(join(projectRoot, ".gemini/commands/qult-spec.toml"), "utf8");
		expect(toml).toContain('description = "');
		expect(toml).toContain('prompt = """');
	});
});
