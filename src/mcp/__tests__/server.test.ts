import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../store/index.js";
import { createMCPServer } from "../server.js";

describe("createMCPServer", () => {
	let tmpDir: string;
	let store: Store;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "server-test-"));
		store = Store.open(join(tmpDir, "test.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates MCP server instance without error", () => {
		const server = createMCPServer(store, null, "0.0.0-test");
		expect(server).toBeDefined();
	});

	it("creates server with null embedder (no Voyage key)", () => {
		const server = createMCPServer(store, null, "0.0.0-test");
		expect(server).toBeDefined();
	});

	it("accepts version string", () => {
		const server = createMCPServer(store, null, "1.2.3");
		expect(server).toBeDefined();
	});
});
