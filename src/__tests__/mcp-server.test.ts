import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findLatestStateFile,
	handleRequest,
	handleTool,
	readJson,
	resetMcpCache,
	TOOL_DEFS,
} from "../mcp-server.ts";

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

		const pastTime = Date.now() - 10000;
		const { utimesSync } = require("node:fs");
		utimesSync(target, pastTime / 1000, pastTime / 1000);
		writeFileSync(newer, '[{"file":"xyz"}]');

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

describe("handleTool", () => {
	it("get_pending_fixes returns empty message when no fixes", () => {
		const result = handleTool("get_pending_fixes", TEST_DIR);
		expect(result.content[0]!.text).toBe("No pending fixes.");
	});

	it("get_pending_fixes returns formatted fixes from state file", () => {
		const fixes = [{ file: "/src/foo.ts", errors: ["error: unused var"], gate: "lint" }];
		writeFileSync(join(STATE_DIR, "pending-fixes.json"), JSON.stringify(fixes));

		const result = handleTool("get_pending_fixes", TEST_DIR);
		const text = result.content[0]!.text;
		expect(text).toContain("1 pending fix(es)");
		expect(text).toContain("[lint] /src/foo.ts");
		expect(text).toContain("error: unused var");
	});

	it("get_session_status returns state from file", () => {
		const state = {
			last_commit_at: "2026-01-01T00:00:00Z",
			test_passed_at: null,
			review_completed_at: null,
		};
		writeFileSync(join(STATE_DIR, "session-state.json"), JSON.stringify(state));

		const result = handleTool("get_session_status", TEST_DIR);
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.last_commit_at).toBe("2026-01-01T00:00:00Z");
		expect(parsed.test_passed_at).toBeNull();
	});

	it("get_session_status returns isError when no state", () => {
		const result = handleTool("get_session_status", TEST_DIR);
		expect(result.content[0]!.text).toContain("No session state");
		expect(result.isError).toBe(true);
	});

	it("get_gate_config returns gates from file", () => {
		const gates = {
			on_write: { lint: { command: "bun biome check {file}" } },
			on_commit: { test: { command: "bun vitest run" } },
		};
		writeFileSync(join(TEST_DIR, ".qult", "gates.json"), JSON.stringify(gates));

		const result = handleTool("get_gate_config", TEST_DIR);
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.on_write.lint.command).toBe("bun biome check {file}");
		expect(parsed.on_commit.test.command).toBe("bun vitest run");
	});

	it("get_gate_config returns isError when no gates", () => {
		const result = handleTool("get_gate_config", TEST_DIR);
		expect(result.content[0]!.text).toContain("No gates configured");
		expect(result.isError).toBe(true);
	});

	it("get_pending_fixes reads session-scoped file", () => {
		const fixes = [{ file: "/src/bar.ts", errors: ["type error"], gate: "typecheck" }];
		writeFileSync(join(STATE_DIR, "pending-fixes-abc123.json"), JSON.stringify(fixes));

		const result = handleTool("get_pending_fixes", TEST_DIR);
		const text = result.content[0]!.text;
		expect(text).toContain("[typecheck] /src/bar.ts");
	});

	it("returns error for unknown tool", () => {
		const result = handleTool("nonexistent_tool", TEST_DIR);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Unknown tool");
	});
});

describe("handleRequest (JSON-RPC)", () => {
	it("initialize returns server info and capabilities", () => {
		const response = handleRequest(
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
			TEST_DIR,
		);
		expect(response).not.toBeNull();
		expect(response!.id).toBe(1);
		const result = response!.result as Record<string, unknown>;
		expect(result.protocolVersion).toBe("2024-11-05");
		expect(result.capabilities).toEqual({ tools: {} });
		const serverInfo = result.serverInfo as Record<string, string>;
		expect(serverInfo.name).toBe("qult");
	});

	it("tools/list returns 3 tool definitions", () => {
		const response = handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, TEST_DIR);
		const result = response!.result as { tools: { name: string }[] };
		expect(result.tools).toHaveLength(3);
		expect(result.tools.map((t) => t.name)).toEqual([
			"get_pending_fixes",
			"get_session_status",
			"get_gate_config",
		]);
	});

	it("tools/call dispatches to correct handler", () => {
		const response = handleRequest(
			{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_pending_fixes" } },
			TEST_DIR,
		);
		const result = response!.result as { content: { text: string }[] };
		expect(result.content[0]!.text).toBe("No pending fixes.");
	});

	it("tools/call returns error for missing tool name", () => {
		const response = handleRequest(
			{ jsonrpc: "2.0", id: 4, method: "tools/call", params: {} },
			TEST_DIR,
		);
		expect(response!.error).toBeDefined();
		expect(response!.error!.code).toBe(-32602);
	});

	it("notifications (no id) return null", () => {
		const response = handleRequest(
			{ jsonrpc: "2.0", method: "notifications/initialized" } as never,
			TEST_DIR,
		);
		expect(response).toBeNull();
	});

	it("ping returns empty result", () => {
		const response = handleRequest({ jsonrpc: "2.0", id: 5, method: "ping" }, TEST_DIR);
		expect(response!.result).toEqual({});
	});

	it("unknown method returns -32601 error", () => {
		const response = handleRequest({ jsonrpc: "2.0", id: 6, method: "unknown/method" }, TEST_DIR);
		expect(response!.error).toBeDefined();
		expect(response!.error!.code).toBe(-32601);
		expect(response!.error!.message).toContain("Method not found");
	});
});

describe("TOOL_DEFS", () => {
	it("has 3 tool definitions", () => {
		expect(TOOL_DEFS).toHaveLength(3);
	});

	it("each tool has name, description, and inputSchema", () => {
		for (const tool of TOOL_DEFS) {
			expect(typeof tool.name).toBe("string");
			expect(typeof tool.description).toBe("string");
			expect(tool.inputSchema.type).toBe("object");
		}
	});
});
