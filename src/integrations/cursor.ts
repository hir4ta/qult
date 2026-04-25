/**
 * Cursor integration: writes `.cursor/rules/qult.mdc` (rules file with
 * frontmatter) and registers the qult MCP server in `.cursor/mcp.json`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteAt } from "../templates/fs.ts";
import { assertConfinedToProject, type GenerationContext, type IntegrationBase } from "./base.ts";
import { writeJsonMcpServer } from "./mcp-util.ts";

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
		const dest = join(ctx.projectRoot, ".cursor/rules/qult.mdc");
		assertConfinedToProject(dest, ctx.projectRoot);
		const constitution = readFileSync(join(ctx.templateRoot, "constitution.md"), "utf8");
		atomicWriteAt(dest, `${RULE_FRONTMATTER}${constitution}`);
	},

	async registerMcpServer(ctx: GenerationContext) {
		writeJsonMcpServer(
			join(ctx.projectRoot, ".cursor/mcp.json"),
			MCP_KEY,
			{ type: "stdio", command: "npx", args: ["qult", "mcp"] },
			ctx.projectRoot,
		);
	},
};
