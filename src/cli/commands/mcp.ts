/**
 * `qult mcp` — start the MCP server (stdio JSON-RPC).
 *
 * Spawns the bundled `dist/mcp-server.js` as a child process and forwards
 * SIGINT/SIGTERM/SIGHUP so the child does not become an orphan when the MCP
 * client terminates the parent. Stdio is inherited so MCP clients see a
 * transparent stdio transport.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { findMcpServerEntry } from "../paths.ts";

const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export async function runMcp(): Promise<number> {
	const entry = findMcpServerEntry();
	const child = spawn(process.execPath, [entry], { stdio: "inherit" });

	const handlers = new Map<NodeJS.Signals, (sig: NodeJS.Signals) => void>();
	for (const sig of FORWARDED_SIGNALS) {
		const handler = () => forwardSignal(child, sig);
		handlers.set(sig, handler);
		process.on(sig, handler);
	}

	try {
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
	} finally {
		for (const [sig, handler] of handlers.entries()) {
			process.off(sig, handler);
		}
	}
}

function forwardSignal(child: ChildProcess, sig: NodeJS.Signals): void {
	if (!child.killed && child.exitCode === null) {
		child.kill(sig);
	}
}
