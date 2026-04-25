import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJsonMcpServer } from "../../integrations/mcp-util.ts";

let projectRoot: string;

beforeEach(() => {
	projectRoot = mkdtempSync(join(tmpdir(), "qult-mcp-util-"));
});
afterEach(() => {
	rmSync(projectRoot, { recursive: true, force: true });
});

describe("writeJsonMcpServer", () => {
	const ENTRY = { type: "stdio", command: "npx", args: ["-y", "@hir4ta/qult", "mcp"] };

	it("creates a new file when missing", () => {
		const path = join(projectRoot, ".mcp.json");
		writeJsonMcpServer(path, "qult", ENTRY, projectRoot);
		const json = JSON.parse(readFileSync(path, "utf8"));
		expect(json.mcpServers.qult).toEqual(ENTRY);
	});

	it("preserves other servers when merging", () => {
		const path = join(projectRoot, ".mcp.json");
		writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "node" } } }));
		writeJsonMcpServer(path, "qult", ENTRY, projectRoot);
		const json = JSON.parse(readFileSync(path, "utf8"));
		expect(json.mcpServers.other.command).toBe("node");
		expect(json.mcpServers.qult).toEqual(ENTRY);
	});

	it("rejects mcpServers that is an array (would silently lose registration)", () => {
		const path = join(projectRoot, ".mcp.json");
		writeFileSync(path, JSON.stringify({ mcpServers: [{ name: "foo" }] }));
		expect(() => writeJsonMcpServer(path, "qult", ENTRY, projectRoot)).toThrowError(
			/not an object/,
		);
	});

	it("rejects mcpServers that is a string", () => {
		const path = join(projectRoot, ".mcp.json");
		writeFileSync(path, JSON.stringify({ mcpServers: "broken" }));
		expect(() => writeJsonMcpServer(path, "qult", ENTRY, projectRoot)).toThrowError(
			/not an object/,
		);
	});

	it("rejects mcpServers: null (would silently lose registration)", () => {
		const path = join(projectRoot, ".mcp.json");
		writeFileSync(path, JSON.stringify({ mcpServers: null }));
		expect(() => writeJsonMcpServer(path, "qult", ENTRY, projectRoot)).toThrowError(
			/not an object/,
		);
	});

	it("rejects writes outside the project root", () => {
		expect(() => writeJsonMcpServer("/tmp/escape.json", "qult", ENTRY, projectRoot)).toThrowError(
			/path escape/,
		);
	});

	it("idempotent: two calls leave the same content", () => {
		const path = join(projectRoot, ".mcp.json");
		writeJsonMcpServer(path, "qult", ENTRY, projectRoot);
		const first = readFileSync(path, "utf8");
		writeJsonMcpServer(path, "qult", ENTRY, projectRoot);
		expect(readFileSync(path, "utf8")).toBe(first);
	});
});
