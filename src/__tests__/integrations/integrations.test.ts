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

describe("ClaudeIntegration", () => {
	it("writes commands, CLAUDE.md, and .mcp.json", async () => {
		await ClaudeIntegration.generateConfigFiles(ctx());
		await ClaudeIntegration.registerMcpServer(ctx());
		expect(existsSync(join(projectRoot, ".claude/commands/qult-spec.md"))).toBe(true);
		expect(existsSync(join(projectRoot, "CLAUDE.md"))).toBe(true);
		const mcp = JSON.parse(readFileSync(join(projectRoot, ".mcp.json"), "utf8"));
		expect(mcp.mcpServers.qult.command).toBe("npx");
		expect(mcp.mcpServers.qult.args).toEqual(["qult", "mcp"]);
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
	it("writes [mcp_servers.qult] block to .codex/config.toml", async () => {
		await CodexIntegration.registerMcpServer(ctx());
		const toml = readFileSync(join(projectRoot, ".codex/config.toml"), "utf8");
		expect(toml).toContain("@qult-mcp-begin");
		expect(toml).toContain("[mcp_servers.qult]");
		expect(toml).toContain('command = "npx"');
	});

	it("replaces existing block in place (idempotent)", async () => {
		await CodexIntegration.registerMcpServer(ctx());
		await CodexIntegration.registerMcpServer(ctx());
		const toml = readFileSync(join(projectRoot, ".codex/config.toml"), "utf8");
		const matches = toml.match(/@qult-mcp-begin/g);
		expect(matches).toHaveLength(1);
	});
});

describe("CursorIntegration", () => {
	it("writes .cursor/rules/qult.mdc with frontmatter and .cursor/mcp.json", async () => {
		await CursorIntegration.generateConfigFiles(ctx());
		await CursorIntegration.registerMcpServer(ctx());
		const mdc = readFileSync(join(projectRoot, ".cursor/rules/qult.mdc"), "utf8");
		expect(mdc.startsWith("---\n")).toBe(true);
		expect(mdc).toContain("alwaysApply: true");
		expect(mdc).toContain("qult Workflow");
		const mcp = JSON.parse(readFileSync(join(projectRoot, ".cursor/mcp.json"), "utf8"));
		expect(mcp.mcpServers.qult.args).toEqual(["qult", "mcp"]);
	});
});

describe("GeminiIntegration", () => {
	it("writes .gemini/commands/*.toml, GEMINI.md, and .gemini/settings.json", async () => {
		await GeminiIntegration.generateConfigFiles(ctx());
		await GeminiIntegration.registerMcpServer(ctx());
		expect(existsSync(join(projectRoot, ".gemini/commands/qult-spec.toml"))).toBe(true);
		expect(existsSync(join(projectRoot, "GEMINI.md"))).toBe(true);
		const settings = JSON.parse(readFileSync(join(projectRoot, ".gemini/settings.json"), "utf8"));
		expect(settings.mcpServers.qult.command).toBe("npx");
		const toml = readFileSync(join(projectRoot, ".gemini/commands/qult-spec.toml"), "utf8");
		expect(toml).toContain('description = "qult spec workflow command"');
		expect(toml).toContain('prompt = """');
	});
});
