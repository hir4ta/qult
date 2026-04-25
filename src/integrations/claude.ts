/**
 * Claude Code integration: writes `.claude/skills/qult-<cmd>/SKILL.md`
 * (Agent Skills format with frontmatter), `CLAUDE.md`, and registers the
 * qult MCP server in `.mcp.json`.
 *
 * Skills are the modern Claude Code mechanism (replacing `.claude/commands/`).
 * Each skill lives in its own directory with a frontmatter-bearing SKILL.md
 * so Claude can auto-invoke based on the description.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteAt } from "../templates/fs.ts";
import { assertConfinedToProject, type GenerationContext, type IntegrationBase } from "./base.ts";
import { writeJsonMcpServer } from "./mcp-util.ts";
import { buildSkillFile } from "./skill-builder.ts";

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
		const skillsRoot = join(ctx.projectRoot, ".claude/skills");
		assertConfinedToProject(skillsRoot, ctx.projectRoot);
		const srcCmdDir = join(ctx.templateRoot, "commands");
		const cmdFiles = readdirSync(srcCmdDir).filter((f) => f.endsWith(".md"));
		for (const f of cmdFiles) {
			const name = f.replace(/\.md$/, "");
			const body = readFileSync(join(srcCmdDir, f), "utf8");
			const dest = join(skillsRoot, `qult-${name}`, "SKILL.md");
			assertConfinedToProject(dest, ctx.projectRoot);
			atomicWriteAt(dest, buildSkillFile(name, body));
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
			{ type: "stdio", command: "npx", args: ["@hir4ta/qult", "mcp"] },
			ctx.projectRoot,
		);
	},
};
