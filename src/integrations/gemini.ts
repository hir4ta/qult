/**
 * Gemini CLI integration: writes `.gemini/commands/*.toml` (TOML command
 * files), `GEMINI.md` (context file with `@AGENTS.md` import), and
 * registers the qult MCP server in `.gemini/settings.json`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteAt } from "../templates/fs.ts";
import { assertConfinedToProject, type GenerationContext, type IntegrationBase } from "./base.ts";
import { writeJsonMcpServer } from "./mcp-util.ts";

const MCP_KEY = "qult";

const GEMINI_MD_HEADER = `# GEMINI.md

@AGENTS.md

This file imports the qult workflow rules from AGENTS.md. Project-specific
overrides should go below this line.
`;

/**
 * Escape a body for embedding inside a TOML basic multi-line string
 * (`"""..."""`). Each `"` in a `"""` triple is replaced by `\"`, expanding
 * `"""` to `\"\"\"` (six characters representing three literal quotes).
 *
 * Why not literal triple-quoted (`'''...'''`)? Literal strings have no
 * escape semantics, so embedding the close marker `'''` is impossible
 * without a hack. Basic multi-line + per-quote escape is robust regardless
 * of body content, including bodies that contain runs of quotes.
 */
function tomlEscape(body: string): string {
	return body.replace(/"""/g, '\\"\\"\\"');
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
		writeJsonMcpServer(
			join(ctx.projectRoot, ".gemini/settings.json"),
			MCP_KEY,
			{ type: "stdio", command: "npx", args: ["qult", "mcp"] },
			ctx.projectRoot,
		);
	},
};
