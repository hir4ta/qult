/**
 * Claude Code integration: writes `.claude/commands/*.md`, `CLAUDE.md`,
 * and registers the qult MCP server in `.mcp.json`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteAt } from "../templates/fs.ts";
import { assertConfinedToProject, type GenerationContext, type IntegrationBase } from "./base.ts";
import { writeJsonMcpServer } from "./mcp-util.ts";

const MCP_KEY = "qult";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickPlainObject(value: unknown): Record<string, unknown> {
	return isPlainObject(value) ? value : {};
}

const CLAUDE_MD_HEADER = `# CLAUDE.md

@AGENTS.md

This file imports the qult workflow rules from AGENTS.md. Project-specific
overrides should go below this line.
`;

export const ClaudeIntegration: IntegrationBase = {
	key: "claude",
	displayName: "Claude Code",

	detect(projectRoot) {
		if (existsSync(join(projectRoot, ".claude"))) return true;
		const pkg = join(projectRoot, "package.json");
		if (!existsSync(pkg)) return false;
		try {
			const parsed = JSON.parse(readFileSync(pkg, "utf8")) as unknown;
			if (!isPlainObject(parsed)) return false;
			const deps = pickPlainObject(parsed.dependencies);
			const devDeps = pickPlainObject(parsed.devDependencies);
			return (
				"@anthropic-ai/sdk" in deps ||
				"@anthropic-ai/claude-code" in deps ||
				"@anthropic-ai/sdk" in devDeps ||
				"@anthropic-ai/claude-code" in devDeps
			);
		} catch {
			return false;
		}
	},

	async generateConfigFiles(ctx: GenerationContext) {
		const cmdDir = join(ctx.projectRoot, ".claude/commands");
		assertConfinedToProject(cmdDir, ctx.projectRoot);
		const srcCmdDir = join(ctx.templateRoot, "commands");
		const cmdFiles = readdirSync(srcCmdDir).filter((f) => f.endsWith(".md"));
		for (const f of cmdFiles) {
			const src = join(srcCmdDir, f);
			const dest = join(cmdDir, `qult-${f}`);
			assertConfinedToProject(dest, ctx.projectRoot);
			atomicWriteAt(dest, readFileSync(src, "utf8"));
		}
		const claudeMdPath = join(ctx.projectRoot, "CLAUDE.md");
		if (!existsSync(claudeMdPath) || ctx.force) {
			atomicWriteAt(claudeMdPath, CLAUDE_MD_HEADER);
		}
	},

	async registerMcpServer(ctx: GenerationContext) {
		writeJsonMcpServer(
			join(ctx.projectRoot, ".mcp.json"),
			MCP_KEY,
			{ type: "stdio", command: "npx", args: ["qult", "mcp"] },
			ctx.projectRoot,
		);
	},
};
