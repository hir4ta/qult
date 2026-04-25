/**
 * `qult mcp` — start the MCP server (stdio JSON-RPC).
 *
 * Spawns the bundled `dist/mcp-server.js` as a child process so the CLI
 * itself stays out of the JSON-RPC loop. The child inherits stdin/stdout/
 * stderr so MCP clients see a transparent stdio transport.
 */

import { spawn } from "node:child_process";
import { findMcpServerEntry } from "../paths.ts";

export async function runMcp(): Promise<number> {
	const entry = findMcpServerEntry();
	const child = spawn(process.execPath, [entry], { stdio: "inherit" });
	return await new Promise<number>((res) => {
		child.on("exit", (code, signal) => {
			if (signal) {
				process.stderr.write(`mcp server killed by ${signal}\n`);
				res(1);
				return;
			}
			res(code ?? 0);
		});
	});
}
