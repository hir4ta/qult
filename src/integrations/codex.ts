/**
 * OpenAI Codex CLI integration:
 *  - Registers the qult MCP server in `~/.codex/config.toml` (Codex only
 *    supports user-level config; project-local `.codex/config.toml` is
 *    ignored). A `[qult] codex MCP registered in ~/.codex/...` notice is
 *    written to stderr to signal the global side-effect.
 *  - Writes per-command skills to `.agents/skills/qult-<cmd>/SKILL.md` so the
 *    Codex CLI's built-in `/skills` command can dispatch them.
 *  - Workflow guidance is delivered via the project-root `AGENTS.md`
 *    (Codex's native context file; written by the AGENTS.md generator).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteAt } from "../templates/fs.ts";
import { assertConfinedToProject, type GenerationContext, type IntegrationBase } from "./base.ts";
import { resolveMcpCommand } from "./mcp-command.ts";
import { buildSkillFile } from "./skill-builder.ts";

/**
 * Resolve the Codex CLI config path. Defaults to `~/.codex/config.toml`
 * (Codex's only supported location). Tests override via the
 * `QULT_CODEX_CONFIG_PATH` env var to avoid mutating the user's real config.
 */
function codexConfigPath(): string {
	return process.env.QULT_CODEX_CONFIG_PATH ?? join(homedir(), ".codex/config.toml");
}

const MCP_BLOCK_BEGIN = "# @qult-mcp-begin (managed by qult)";
const MCP_BLOCK_END = "# @qult-mcp-end";

const BEGIN_LINE_RE = /^# @qult-mcp-begin \(managed by qult\)\r?$/m;
const END_LINE_RE = /^# @qult-mcp-end\r?$/m;

function buildMcpBlock(): string {
	const cmd = resolveMcpCommand();
	const argsToml = cmd.args.map((a) => JSON.stringify(a)).join(", ");
	return `${MCP_BLOCK_BEGIN}
[mcp_servers.qult]
command = ${JSON.stringify(cmd.command)}
args = [${argsToml}]
${MCP_BLOCK_END}`;
}

export const CodexIntegration: IntegrationBase = {
	key: "codex",
	displayName: "OpenAI Codex CLI",

	detect(projectRoot) {
		return existsSync(join(projectRoot, ".codex")) || existsSync(codexConfigPath());
	},

	async generateConfigFiles(ctx: GenerationContext) {
		// `.agents/skills/` is the Agent Skills standard path that Codex CLI
		// resolves first (https://developers.openai.com/codex/skills).
		const skillsRoot = join(ctx.projectRoot, ".agents/skills");
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

	async registerMcpServer(_ctx: GenerationContext) {
		// Codex reads ONLY user-level `~/.codex/config.toml`. We deliberately
		// write outside the project here; this is the unavoidable global
		// side-effect for Codex compatibility. Surface it on stderr so the
		// architect sees the user-level write happened.
		const path = codexConfigPath();
		let existing = "";
		if (existsSync(path)) existing = readFileSync(path, "utf8");

		const beginMatch = BEGIN_LINE_RE.exec(existing);
		if (beginMatch) {
			const beginIdx = beginMatch.index;
			const remainder = existing.slice(beginIdx);
			const endMatch = END_LINE_RE.exec(remainder);
			if (endMatch) {
				const endIdx = beginIdx + endMatch.index + endMatch[0].length;
				atomicWriteAt(
					path,
					`${existing.slice(0, beginIdx)}${buildMcpBlock()}${existing.slice(endIdx)}`,
				);
				process.stderr.write(`[qult] codex MCP updated in ${path}\n`);
				return;
			}
			atomicWriteAt(path, `${existing.slice(0, beginIdx)}${buildMcpBlock()}\n`);
			process.stderr.write(`[qult] codex MCP repaired (truncated marker) in ${path}\n`);
			return;
		}
		const trimmed = existing.replace(/\n+$/, "");
		const prefix = trimmed.length === 0 ? "" : `${trimmed}\n\n`;
		atomicWriteAt(path, `${prefix}${buildMcpBlock()}\n`);
		process.stderr.write(
			`[qult] codex MCP registered in ${path} (user-level config — affects all your codex projects)\n`,
		);
	},
};
