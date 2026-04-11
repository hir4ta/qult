import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LspClient } from "../lsp/client.ts";

describe("LspClient", () => {
	it("sends initialize and receives capabilities", async () => {
		// Create a mock LSP server that responds to initialize
		const mockServer = spawn("node", [
			"-e",
			`
			process.stdin.setEncoding('utf-8');
			let buffer = '';
			process.stdin.on('data', (data) => {
				buffer += data;
				while (true) {
					const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
					if (headerEnd === -1) break;
					const header = buffer.slice(0, headerEnd);
					const lenMatch = header.match(/Content-Length: (\\d+)/);
					if (!lenMatch) break;
					const len = parseInt(lenMatch[1]);
					const bodyStart = headerEnd + 4;
					if (buffer.length < bodyStart + len) break;
					const body = buffer.slice(bodyStart, bodyStart + len);
					buffer = buffer.slice(bodyStart + len);
					const msg = JSON.parse(body);
					if (msg.method === 'initialize') {
						const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
						process.stdout.write('Content-Length: ' + resp.length + '\\r\\n\\r\\n' + resp);
					} else if (msg.method === 'shutdown') {
						const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null });
						process.stdout.write('Content-Length: ' + resp.length + '\\r\\n\\r\\n' + resp);
					} else if (msg.method === 'exit') {
						process.exit(0);
					}
				}
			});
			`,
		]);

		const client = new LspClient(mockServer);
		const caps = await client.initialize("/tmp/test-project");
		expect(caps).toBeDefined();
		expect(caps.capabilities).toBeDefined();
		expect(caps.capabilities.textDocumentSync).toBe(1);

		await client.shutdown();
	});

	it("times out on unresponsive server", async () => {
		const silentServer = spawn("node", ["-e", "setTimeout(() => {}, 60000)"]);
		const client = new LspClient(silentServer, { timeout: 200 });

		await expect(client.initialize("/tmp/test")).rejects.toThrow(/timeout/i);

		silentServer.kill();
	});

	it("handles server crash gracefully", async () => {
		const crashServer = spawn("node", ["-e", "process.exit(1)"]);
		const client = new LspClient(crashServer);

		await expect(client.initialize("/tmp/test")).rejects.toThrow();
	});
});
