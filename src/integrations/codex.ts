/**
 * OpenAI Codex CLI integration: registers the qult MCP server in
 * `.codex/config.toml` under `[mcp_servers.qult]`. The workflow guidance is
 * delivered via AGENTS.md (the Codex default context file).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteAt } from "../templates/fs.ts";
import { assertConfinedToProject, type GenerationContext, type IntegrationBase } from "./base.ts";

const MCP_BLOCK_BEGIN = "# @qult-mcp-begin (managed by qult)";
const MCP_BLOCK_END = "# @qult-mcp-end";

const MCP_BLOCK = `${MCP_BLOCK_BEGIN}
[mcp_servers.qult]
command = "npx"
args = ["qult", "mcp"]
${MCP_BLOCK_END}`;

export const CodexIntegration: IntegrationBase = {
	key: "codex",
	displayName: "OpenAI Codex CLI",

	detect(projectRoot) {
		return existsSync(join(projectRoot, ".codex"));
	},

	async generateConfigFiles(_ctx: GenerationContext) {
		// Codex reads AGENTS.md natively. agents-md.ts handles the project-root file;
		// nothing else to write here.
	},

	async registerMcpServer(ctx: GenerationContext) {
		const path = join(ctx.projectRoot, ".codex/config.toml");
		assertConfinedToProject(path, ctx.projectRoot);
		let existing = "";
		if (existsSync(path)) {
			existing = readFileSync(path, "utf8");
			const beginIdx = existing.indexOf(MCP_BLOCK_BEGIN);
			if (beginIdx !== -1) {
				const endIdx = existing.indexOf(MCP_BLOCK_END, beginIdx);
				if (endIdx !== -1) {
					const after = existing.slice(endIdx + MCP_BLOCK_END.length);
					existing = `${existing.slice(0, beginIdx)}${MCP_BLOCK}${after}`;
					atomicWriteAt(path, existing);
					return;
				}
			}
		}
		const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
		atomicWriteAt(path, `${existing}${sep}${existing.length > 0 ? "\n" : ""}${MCP_BLOCK}\n`);
	},
};
