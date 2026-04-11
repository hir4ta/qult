import type { ChildProcess } from "node:child_process";

export interface LspClientOptions {
	timeout?: number; // ms, default 5000
}

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: { code: number; message: string };
}

/**
 * Lightweight LSP client over JSON-RPC stdio transport.
 * Sends Content-Length framed messages to an LSP server process.
 */
export class LspClient {
	private process: ChildProcess;
	private nextId = 1;
	private pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private buffer = "";
	private timeout: number;
	private alive = true;

	constructor(serverProcess: ChildProcess, options?: LspClientOptions) {
		this.process = serverProcess;
		this.timeout = options?.timeout ?? 5000;

		this.process.stdout?.setEncoding("utf-8");
		this.process.stdout?.on("data", (data: string) => this.onData(data));
		this.process.on("exit", () => {
			this.alive = false;
			for (const [, p] of this.pending) {
				p.reject(new Error("LSP server exited"));
			}
			this.pending.clear();
		});
		this.process.on("error", () => {
			this.alive = false;
		});
	}

	/** Send an LSP request and wait for response. */
	async request(method: string, params?: unknown): Promise<unknown> {
		if (!this.alive) throw new Error("LSP server is not running");

		const id = this.nextId++;
		const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		const body = JSON.stringify(msg);
		const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`LSP request timeout: ${method}`));
			}, this.timeout);

			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});

			this.process.stdin?.write(frame);
		});
	}

	/** Send an LSP notification (no response expected). */
	notify(method: string, params?: unknown): void {
		if (!this.alive) return;
		const msg = { jsonrpc: "2.0", method, params };
		const body = JSON.stringify(msg);
		const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
		this.process.stdin?.write(frame);
	}

	/** Initialize the LSP server. */
	async initialize(rootUri: string): Promise<{ capabilities: Record<string, unknown> }> {
		const result = (await this.request("initialize", {
			processId: process.pid,
			rootUri: `file://${rootUri}`,
			capabilities: {},
		})) as { capabilities: Record<string, unknown> };
		this.notify("initialized", {});
		return result;
	}

	/** Shutdown the LSP server gracefully. */
	async shutdown(): Promise<void> {
		try {
			await this.request("shutdown");
			this.notify("exit");
		} catch {
			// Server may have already exited
			this.process.kill();
		}
	}

	/** Parse incoming Content-Length framed messages. */
	private onData(data: string): void {
		this.buffer += data;
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;
			const header = this.buffer.slice(0, headerEnd);
			const lenMatch = header.match(/Content-Length:\s*(\d+)/);
			if (!lenMatch) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}
			const len = Number.parseInt(lenMatch[1]!, 10);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + len) break;
			const body = this.buffer.slice(bodyStart, bodyStart + len);
			this.buffer = this.buffer.slice(bodyStart + len);

			try {
				const msg = JSON.parse(body) as JsonRpcResponse;
				if (msg.id !== undefined && this.pending.has(msg.id)) {
					const p = this.pending.get(msg.id)!;
					this.pending.delete(msg.id);
					if (msg.error) {
						p.reject(new Error(`LSP error: ${msg.error.message}`));
					} else {
						p.resolve(msg.result);
					}
				}
			} catch {
				// Malformed message, skip
			}
		}
	}
}
