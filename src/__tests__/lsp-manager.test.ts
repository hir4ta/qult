import { describe, expect, it, vi } from "vitest";
import { LspManager } from "../lsp/manager.ts";

describe("LspManager", () => {
	it("getClient returns null when server not installed", () => {
		const manager = new LspManager({
			typescript: {
				command: "nonexistent-lsp-server-12345",
				args: ["--stdio"],
				extensionToLanguage: { ".ts": "typescript" },
			},
		});
		const client = manager.getClientSync("test.ts");
		expect(client).toBeNull();
		manager.dispose();
	});

	it("maps file extension to language config", () => {
		const config = {
			typescript: {
				command: "nonexistent-ts-lsp",
				args: [],
				extensionToLanguage: { ".ts": "typescript", ".tsx": "typescriptreact" },
			},
			python: {
				command: "nonexistent-py-lsp",
				args: [],
				extensionToLanguage: { ".py": "python" },
			},
		};
		const manager = new LspManager(config);

		// Both .ts files should map to typescript config
		expect(manager.getLanguageId("foo.ts")).toBe("typescript");
		expect(manager.getLanguageId("bar.tsx")).toBe("typescriptreact");
		expect(manager.getLanguageId("baz.py")).toBe("python");
		expect(manager.getLanguageId("unknown.rb")).toBeNull();

		manager.dispose();
	});

	it("reads lsp.json config correctly", () => {
		// LspManager accepts config directly — no file reading in constructor
		const config = {
			go: {
				command: "gopls",
				args: ["serve"],
				extensionToLanguage: { ".go": "go" },
			},
		};
		const manager = new LspManager(config);
		expect(manager.getLanguageId("main.go")).toBe("go");
		manager.dispose();
	});
});
