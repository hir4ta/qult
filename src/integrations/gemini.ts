/**
 * Gemini CLI integration: writes `.gemini/commands/*.toml` (TOML command
 * files), `GEMINI.md` (context file with `@AGENTS.md` import), and
 * registers the qult MCP server in `.gemini/settings.json`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteAt } from "../templates/fs.ts";
import { assertConfinedToProject, type GenerationContext, type IntegrationBase } from "./base.ts";

const MCP_KEY = "qult";

const GEMINI_MD_HEADER = `# GEMINI.md

@AGENTS.md

This file imports the qult workflow rules from AGENTS.md. Project-specific
overrides should go below this line.
`;

/** Escape a markdown body for embedding inside a TOML triple-quoted string. */
function tomlEscape(body: string): string {
	// Triple-quoted basic strings allow newlines; only `"""` needs to be split.
	return body.replace(/"""/g, '""\\"');
}

export const GeminiIntegration: IntegrationBase = {
	key: "gemini",
	displayName: "Gemini CLI",

	detect(projectRoot) {
		return existsSync(join(projectRoot, ".gemini"));
	},

	async generateConfigFiles(ctx: GenerationContext) {
		const cmdDir = join(ctx.projectRoot, ".gemini/commands");
		assertConfinedToProject(cmdDir, ctx.projectRoot);
		const srcCmdDir = join(ctx.templateRoot, "commands");
		const cmdFiles = readdirSync(srcCmdDir).filter((f) => f.endsWith(".md"));
		for (const f of cmdFiles) {
			const name = f.replace(/\.md$/, "");
			const body = readFileSync(join(srcCmdDir, f), "utf8");
			const description = `qult ${name} workflow command`;
			const toml = `description = "${description}"\nprompt = """\n${tomlEscape(body)}\n"""\n`;
			const dest = join(cmdDir, `qult-${name}.toml`);
			assertConfinedToProject(dest, ctx.projectRoot);
			atomicWriteAt(dest, toml);
		}
		const geminiMdPath = join(ctx.projectRoot, "GEMINI.md");
		if (!existsSync(geminiMdPath) || ctx.force) {
			atomicWriteAt(geminiMdPath, GEMINI_MD_HEADER);
		}
	},

	async registerMcpServer(ctx: GenerationContext) {
		const path = join(ctx.projectRoot, ".gemini/settings.json");
		assertConfinedToProject(path, ctx.projectRoot);
		const existing = existsSync(path)
			? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
			: {};
		const servers =
			(existing.mcpServers as Record<string, unknown> | undefined) ??
			({} as Record<string, unknown>);
		servers[MCP_KEY] = { command: "npx", args: ["qult", "mcp"] };
		existing.mcpServers = servers;
		atomicWriteAt(path, `${JSON.stringify(existing, null, 2)}\n`);
	},
};
