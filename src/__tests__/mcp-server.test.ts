import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, findLatestStateFile, readJson, resetMcpCache } from "../mcp-server.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-mcp-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
const originalCwd = process.cwd();

beforeEach(() => {
	resetMcpCache();
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("readJson", () => {
	it("reads valid JSON file", () => {
		const path = join(TEST_DIR, "test.json");
		writeFileSync(path, JSON.stringify({ key: "value" }));
		expect(readJson(path, null)).toEqual({ key: "value" });
	});

	it("returns fallback for missing file", () => {
		expect(readJson(join(TEST_DIR, "nonexistent.json"), [])).toEqual([]);
	});

	it("returns fallback for corrupt JSON", () => {
		const path = join(TEST_DIR, "corrupt.json");
		writeFileSync(path, "not valid json{{{");
		expect(readJson(path, [])).toEqual([]);
	});
});

describe("findLatestStateFile", () => {
	it("returns non-scoped file when no scoped files exist", () => {
		const result = findLatestStateFile(TEST_DIR, "pending-fixes");
		expect(result).toBe(join(STATE_DIR, "pending-fixes.json"));
	});

	it("returns most recently modified file", () => {
		const older = join(STATE_DIR, "pending-fixes-session-old.json");
		const newer = join(STATE_DIR, "pending-fixes-session-new.json");
		writeFileSync(older, "[]");

		// Ensure different mtime
		const pastTime = Date.now() - 10000;
		const { utimesSync } = require("node:fs");
		utimesSync(older, pastTime / 1000, pastTime / 1000);

		writeFileSync(newer, '[{"file":"new"}]');
		const result = findLatestStateFile(TEST_DIR, "pending-fixes");
		expect(result).toBe(newer);
	});

	it("prefers session from latest-session.json over mtime", () => {
		const target = join(STATE_DIR, "pending-fixes-abc.json");
		const newer = join(STATE_DIR, "pending-fixes-xyz.json");
		writeFileSync(target, '[{"file":"abc"}]');

		// Make xyz newer by mtime
		const pastTime = Date.now() - 10000;
		const { utimesSync } = require("node:fs");
		utimesSync(target, pastTime / 1000, pastTime / 1000);
		writeFileSync(newer, '[{"file":"xyz"}]');

		// Write latest-session.json pointing to abc
		writeFileSync(
			join(STATE_DIR, "latest-session.json"),
			JSON.stringify({ session_id: "abc", updated_at: new Date().toISOString() }),
		);

		const result = findLatestStateFile(TEST_DIR, "pending-fixes");
		expect(result).toBe(target);
	});

	it("falls back to mtime when latest-session.json is corrupt", () => {
		const older = join(STATE_DIR, "pending-fixes-old.json");
		const newer = join(STATE_DIR, "pending-fixes-new.json");
		writeFileSync(older, "[]");

		const pastTime = Date.now() - 10000;
		const { utimesSync } = require("node:fs");
		utimesSync(older, pastTime / 1000, pastTime / 1000);
		writeFileSync(newer, "[]");

		writeFileSync(join(STATE_DIR, "latest-session.json"), "not valid json{{{");

		const result = findLatestStateFile(TEST_DIR, "pending-fixes");
		expect(result).toBe(newer);
	});

	it("falls back to mtime when latest-session.json points to nonexistent session", () => {
		const existing = join(STATE_DIR, "pending-fixes-real.json");
		writeFileSync(existing, "[]");
		writeFileSync(
			join(STATE_DIR, "latest-session.json"),
			JSON.stringify({ session_id: "ghost", updated_at: new Date().toISOString() }),
		);

		const result = findLatestStateFile(TEST_DIR, "pending-fixes");
		expect(result).toBe(existing);
	});

	it("returns non-scoped path when state dir does not exist", () => {
		rmSync(join(TEST_DIR, ".qult"), { recursive: true, force: true });
		const result = findLatestStateFile(TEST_DIR, "pending-fixes");
		expect(result).toContain("pending-fixes.json");
	});
});

describe("MCP server tools", () => {
	it("get_pending_fixes returns empty message when no fixes", async () => {
		const server = createServer(TEST_DIR);
		const tools = await listTools(server);
		expect(tools.some((t) => t.name === "get_pending_fixes")).toBe(true);

		const result = await callTool(server, "get_pending_fixes", {});
		expect(result.content[0]!.text).toBe("No pending fixes.");
	});

	it("get_pending_fixes returns formatted fixes from state file", async () => {
		const fixes = [{ file: "/src/foo.ts", errors: ["error: unused var"], gate: "lint" }];
		writeFileSync(join(STATE_DIR, "pending-fixes.json"), JSON.stringify(fixes));

		const server = createServer(TEST_DIR);
		const result = await callTool(server, "get_pending_fixes", {});
		const text = result.content[0]!.text;
		expect(text).toContain("1 pending fix(es)");
		expect(text).toContain("[lint] /src/foo.ts");
		expect(text).toContain("error: unused var");
	});

	it("get_session_status returns state from file", async () => {
		const state = {
			last_commit_at: "2026-01-01T00:00:00Z",
			test_passed_at: null,
			review_completed_at: null,
		};
		writeFileSync(join(STATE_DIR, "session-state.json"), JSON.stringify(state));

		const server = createServer(TEST_DIR);
		const result = await callTool(server, "get_session_status", {});
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.last_commit_at).toBe("2026-01-01T00:00:00Z");
		expect(parsed.test_passed_at).toBeNull();
	});

	it("get_session_status returns isError when no state", async () => {
		const server = createServer(TEST_DIR);
		const result = await callTool(server, "get_session_status", {});
		expect(result.content[0]!.text).toContain("No session state");
		expect(result.isError).toBe(true);
	});

	it("get_gate_config returns gates from file", async () => {
		const gates = {
			on_write: { lint: { command: "bun biome check {file}" } },
			on_commit: { test: { command: "bun vitest run" } },
		};
		writeFileSync(join(TEST_DIR, ".qult", "gates.json"), JSON.stringify(gates));

		const server = createServer(TEST_DIR);
		const result = await callTool(server, "get_gate_config", {});
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.on_write.lint.command).toBe("bun biome check {file}");
		expect(parsed.on_commit.test.command).toBe("bun vitest run");
	});

	it("get_gate_config returns isError when no gates", async () => {
		const server = createServer(TEST_DIR);
		const result = await callTool(server, "get_gate_config", {});
		expect(result.content[0]!.text).toContain("No gates configured");
		expect(result.isError).toBe(true);
	});

	it("get_pending_fixes reads session-scoped file", async () => {
		const fixes = [{ file: "/src/bar.ts", errors: ["type error"], gate: "typecheck" }];
		writeFileSync(join(STATE_DIR, "pending-fixes-abc123.json"), JSON.stringify(fixes));

		const server = createServer(TEST_DIR);
		const result = await callTool(server, "get_pending_fixes", {});
		const text = result.content[0]!.text;
		expect(text).toContain("[typecheck] /src/bar.ts");
	});
});

// --- Test helpers: call MCP tools without transport ---

interface ToolDef {
	name: string;
}

interface ToolResult {
	content: { type: string; text: string }[];
	isError?: boolean;
}

interface RegisteredTool {
	handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function listTools(server: ReturnType<typeof createServer>): ToolDef[] {
	// biome-ignore lint/suspicious/noExplicitAny: accessing SDK internals for test
	const internal = server as any;
	const tools = internal._registeredTools as Record<string, RegisteredTool>;
	return Object.keys(tools).map((name) => ({ name }));
}

async function callTool(
	server: ReturnType<typeof createServer>,
	name: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	// biome-ignore lint/suspicious/noExplicitAny: accessing SDK internals for test
	const internal = server as any;
	const tools = internal._registeredTools as Record<string, RegisteredTool>;
	const tool = tools[name];
	if (!tool) throw new Error(`Tool ${name} not found`);
	return tool.handler(args);
}
