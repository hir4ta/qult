/**
 * Cursor integration: writes
 *  - `.cursor/rules/qult.mdc` (always-applied rules — full constitution as
 *    project context)
 *  - `.cursor/skills/qult-<cmd>/SKILL.md` (per-command Agent Skills so users
 *    can slash-invoke `/qult-spec` etc.)
 *  - `.cursor/mcp.json` (qult MCP server registration with `type: "stdio"`)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteAt } from "../templates/fs.ts";
import { assertConfinedToProject, type GenerationContext, type IntegrationBase } from "./base.ts";
import { writeJsonMcpServer } from "./mcp-util.ts";
import { buildSkillFile } from "./skill-builder.ts";

const MCP_KEY = "qult";

const RULE_FRONTMATTER = `---
description: qult Spec-Driven Development workflow
alwaysApply: true
---

`;

export const CursorIntegration: IntegrationBase = {
	key: "cursor",
	displayName: "Cursor",

	detect(projectRoot) {
		return (
			existsSync(join(projectRoot, ".cursor")) || existsSync(join(projectRoot, ".cursorrules"))
		);
	},

	async generateConfigFiles(ctx: GenerationContext) {
		// 1. Always-applied rules file (full constitution as ambient context).
		const rulesPath = join(ctx.projectRoot, ".cursor/rules/qult.mdc");
		assertConfinedToProject(rulesPath, ctx.projectRoot);
		const constitution = readFileSync(join(ctx.templateRoot, "constitution.md"), "utf8");
		atomicWriteAt(rulesPath, `${RULE_FRONTMATTER}${constitution}`);

		// 2. Per-command skills for slash-invoke.
		const skillsRoot = join(ctx.projectRoot, ".cursor/skills");
		assertConfinedToProject(skillsRoot, ctx.projectRoot);
		const srcCmdDir = join(ctx.templateRoot, "commands");
		for (const f of readdirSync(srcCmdDir).filter((x) => x.endsWith(".md"))) {
			const name = f.replace(/\.md$/, "");
			const body = readFileSync(join(srcCmdDir, f), "utf8");
			const dest = join(skillsRoot, `qult-${name}`, "SKILL.md");
			assertConfinedToProject(dest, ctx.projectRoot);
			atomicWriteAt(dest, buildSkillFile(name, body));
		}
	},

	async registerMcpServer(ctx: GenerationContext) {
		writeJsonMcpServer(
			join(ctx.projectRoot, ".cursor/mcp.json"),
			MCP_KEY,
			{ type: "stdio", command: "npx", args: ["-y", "@hir4ta/qult", "mcp"] },
			ctx.projectRoot,
		);
	},
};
