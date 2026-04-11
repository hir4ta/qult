import { execSync, spawn } from "node:child_process";
import { extname } from "node:path";
import { LspClient } from "./client.ts";

export interface LspServerConfig {
	command: string;
	args?: string[];
	extensionToLanguage: Record<string, string>;
}

/**
 * Manages LSP server instances per language.
 * Lazy-starts servers on first access.
 * Fail-open: returns null when server is not installed or fails to start.
 */
export class LspManager {
	private config: Record<string, LspServerConfig>;
	private extToServer = new Map<string, string>();
	private extToLangId = new Map<string, string>();
	private clients = new Map<string, LspClient>();

	constructor(config: Record<string, LspServerConfig>) {
		this.config = config;
		// Build extension → server name mapping
		for (const [name, server] of Object.entries(config)) {
			for (const [ext, langId] of Object.entries(server.extensionToLanguage)) {
				this.extToServer.set(ext, name);
				this.extToLangId.set(ext, langId);
			}
		}
	}

	/** Get the language ID for a file extension. Returns null if unsupported. */
	getLanguageId(file: string): string | null {
		const ext = extname(file).toLowerCase();
		return this.extToLangId.get(ext) ?? null;
	}

	/** Get an LSP client for a file, synchronously. Returns null if unavailable (fail-open). */
	getClientSync(file: string): LspClient | null {
		const ext = extname(file).toLowerCase();
		const serverName = this.extToServer.get(ext);
		if (!serverName) return null;

		// Check cache
		if (this.clients.has(serverName)) return this.clients.get(serverName)!;

		// Check if command is reachable
		const server = this.config[serverName]!;
		if (!this.isReachable(server.command)) return null;

		// Lazy-start server
		try {
			const proc = spawn(server.command, server.args ?? [], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			const client = new LspClient(proc);
			this.clients.set(serverName, client);
			return client;
		} catch {
			return null; // fail-open
		}
	}

	/** Cleanup all running LSP server processes. */
	dispose(): void {
		for (const [, client] of this.clients) {
			try {
				client.shutdown();
			} catch {
				// best-effort cleanup
			}
		}
		this.clients.clear();
	}

	/** Check if a command is reachable in PATH. */
	private isReachable(command: string): boolean {
		try {
			execSync(`which ${command}`, { stdio: "ignore", timeout: 2000 });
			return true;
		} catch {
			return false;
		}
	}
}
