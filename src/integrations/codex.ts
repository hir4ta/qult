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

// Anchor markers to line start so a comment elsewhere mentioning the marker
// text (e.g. inside prose / code samples) cannot be misidentified as a real
// block boundary. Re-built from a string template to preserve exact content.
// Allow optional \r before line end so CRLF (Windows-edited) configs match.
const BEGIN_LINE_RE = /^# @qult-mcp-begin \(managed by qult\)\r?$/m;
const END_LINE_RE = /^# @qult-mcp-end\r?$/m;

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
		if (existsSync(path)) existing = readFileSync(path, "utf8");

		// Match the marker only when it appears as a complete line. `m` flag on
		// the regex anchors `^`/`$` to line boundaries so prose containing the
		// marker substring can't trigger a slice-and-replace.
		const beginMatch = BEGIN_LINE_RE.exec(existing);
		if (beginMatch) {
			const beginIdx = beginMatch.index;
			const remainder = existing.slice(beginIdx);
			const endMatch = END_LINE_RE.exec(remainder);
			if (endMatch) {
				const endIdx = beginIdx + endMatch.index + endMatch[0].length;
				atomicWriteAt(path, `${existing.slice(0, beginIdx)}${MCP_BLOCK}${existing.slice(endIdx)}`);
				return;
			}
			// Truncated: end marker missing. Replace from begin to EOF rather
			// than appending another block (which would create duplicate begins).
			atomicWriteAt(path, `${existing.slice(0, beginIdx)}${MCP_BLOCK}\n`);
			return;
		}
		// Append. Normalize trailing newlines to exactly one before the block.
		const trimmed = existing.replace(/\n+$/, "");
		const prefix = trimmed.length === 0 ? "" : `${trimmed}\n\n`;
		atomicWriteAt(path, `${prefix}${MCP_BLOCK}\n`);
	},
};
