/**
 * Claude Code integration: writes `.claude/commands/*.md`, `CLAUDE.md`,
 * and registers the qult MCP server in `.mcp.json`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteAt } from "../templates/fs.ts";
import { assertConfinedToProject, type GenerationContext, type IntegrationBase } from "./base.ts";

const MCP_KEY = "qult";

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
			const j = JSON.parse(readFileSync(pkg, "utf8")) as Record<string, unknown>;
			const deps = { ...(j.dependencies as object), ...(j.devDependencies as object) };
			return "@anthropic-ai/sdk" in deps || "@anthropic-ai/claude-code" in deps;
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
		const path = join(ctx.projectRoot, ".mcp.json");
		assertConfinedToProject(path, ctx.projectRoot);
		const existing = existsSync(path)
			? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
			: {};
		const servers =
			(existing.mcpServers as Record<string, unknown> | undefined) ??
			({} as Record<string, unknown>);
		servers[MCP_KEY] = { type: "stdio", command: "npx", args: ["qult", "mcp"] };
		existing.mcpServers = servers;
		atomicWriteAt(path, `${JSON.stringify(existing, null, 2)}\n`);
	},
};
