import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

	it("tools/list returns 7 tool definitions", () => {
		const response = handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, TEST_DIR);
		const result = response!.result as { tools: { name: string }[] };
		expect(result.tools).toHaveLength(10);
		expect(result.tools.map((t) => t.name)).toEqual([
			"get_pending_fixes",
			"get_session_status",
			"get_gate_config",
			"disable_gate",
			"enable_gate",
			"set_config",
			"clear_pending_fixes",
			"record_review",
			"record_test_pass",
			"record_stage_scores",
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
	it("has 10 tool definitions", () => {
		expect(TOOL_DEFS).toHaveLength(10);
	});

	it("each tool has name, description, and inputSchema", () => {
		for (const tool of TOOL_DEFS) {
			expect(typeof tool.name).toBe("string");
			expect(typeof tool.description).toBe("string");
			expect(tool.inputSchema.type).toBe("object");
		}
	});
});

describe("handleTool: disable_gate / enable_gate", () => {
	it("disable_gate adds gate to disabled_gates in state file", () => {
		// Write gates.json and initial session state
		const qultDir = join(TEST_DIR, ".qult");
		writeFileSync(
			join(qultDir, "gates.json"),
			JSON.stringify({ on_write: { lint: { command: "echo ok" } } }),
		);
		const statePath = join(STATE_DIR, "session-state.json");
		writeFileSync(statePath, JSON.stringify({ disabled_gates: [] }));
		resetMcpCache();

		const result = handleTool("disable_gate", TEST_DIR, {
			gate_name: "lint",
			reason: "Gate is broken for this test session",
		});
		expect(result.content[0]!.text).toContain("disabled");

		const state = JSON.parse(readFileSync(statePath, "utf-8"));
		expect(state.disabled_gates).toContain("lint");
	});

	it("disable_gate rejects unknown gate name", () => {
		const qultDir = join(TEST_DIR, ".qult");
		writeFileSync(
			join(qultDir, "gates.json"),
			JSON.stringify({ on_write: { lint: { command: "echo ok" } } }),
		);
		resetMcpCache();

		const result = handleTool("disable_gate", TEST_DIR, {
			gate_name: "typo",
			reason: "Testing unknown gate rejection",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Unknown gate");
	});

	it("disable_gate accepts 'review' as valid gate name", () => {
		const statePath = join(STATE_DIR, "session-state.json");
		writeFileSync(statePath, JSON.stringify({ disabled_gates: [] }));
		resetMcpCache();

		const result = handleTool("disable_gate", TEST_DIR, {
			gate_name: "review",
			reason: "Review not needed for documentation changes",
		});
		expect(result.content[0]!.text).toContain("disabled");
	});

	it("disable_gate accepts computational detector names (security-check, dead-import-check)", () => {
		const statePath = join(STATE_DIR, "session-state.json");
		writeFileSync(statePath, JSON.stringify({ disabled_gates: [] }));
		resetMcpCache();

		const secResult = handleTool("disable_gate", TEST_DIR, {
			gate_name: "security-check",
			reason: "Security patterns causing false positives",
		});
		expect(secResult.content[0]!.text).toContain("disabled");

		// Re-enable security-check before disabling dead-import to stay under limit
		handleTool("enable_gate", TEST_DIR, { gate_name: "security-check" });
		resetMcpCache();

		const deadResult = handleTool("disable_gate", TEST_DIR, {
			gate_name: "dead-import-check",
			reason: "Dead import check causing false positives",
		});
		expect(deadResult.content[0]!.text).toContain("disabled");
	});

	it("disable_gate requires reason parameter", () => {
		const result = handleTool("disable_gate", TEST_DIR, { gate_name: "review" });
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("reason");
	});

	it("disable_gate rejects short reason", () => {
		const result = handleTool("disable_gate", TEST_DIR, { gate_name: "review", reason: "short" });
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("10 chars");
	});

	it("disable_gate rejects when 2 gates already disabled", () => {
		const statePath = join(STATE_DIR, "session-state.json");
		writeFileSync(statePath, JSON.stringify({ disabled_gates: ["review", "security-check"] }));
		resetMcpCache();

		const result = handleTool("disable_gate", TEST_DIR, {
			gate_name: "dead-import-check",
			reason: "Need to disable a third gate",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Maximum 2");
	});

	it("disable_gate writes audit log entry", () => {
		const result = handleTool("disable_gate", TEST_DIR, {
			gate_name: "review",
			reason: "Review gate is misconfigured",
		});
		expect(result.isError).toBeFalsy();
		const auditLog = JSON.parse(readFileSync(join(STATE_DIR, "audit-log.json"), "utf-8"));
		expect(auditLog).toHaveLength(1);
		expect(auditLog[0].action).toBe("disable_gate");
		expect(auditLog[0].gate_name).toBe("review");
	});

	it("enable_gate removes gate from disabled_gates", () => {
		const qultDir = join(TEST_DIR, ".qult");
		writeFileSync(
			join(qultDir, "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "echo ok" }, typecheck: { command: "echo ok" } },
			}),
		);
		const statePath = join(STATE_DIR, "session-state.json");
		writeFileSync(statePath, JSON.stringify({ disabled_gates: ["lint", "typecheck"] }));
		resetMcpCache();

		const result = handleTool("enable_gate", TEST_DIR, { gate_name: "lint" });
		expect(result.content[0]!.text).toContain("re-enabled");

		const state = JSON.parse(readFileSync(statePath, "utf-8"));
		expect(state.disabled_gates).toEqual(["typecheck"]);
	});

	it("disable_gate returns error without gate_name", () => {
		const result = handleTool("disable_gate", TEST_DIR, { reason: "Testing missing gate_name" });
		expect(result.isError).toBe(true);
	});
});

describe("handleTool: clear_pending_fixes", () => {
	it("clears all pending fixes", () => {
		const fixesPath = join(STATE_DIR, "pending-fixes.json");
		writeFileSync(fixesPath, JSON.stringify([{ file: "a.ts", errors: ["err"], gate: "lint" }]));
		resetMcpCache();

		const result = handleTool("clear_pending_fixes", TEST_DIR, {
			reason: "False positives from linter update",
		});
		expect(result.content[0]!.text).toContain("cleared");

		const fixes = JSON.parse(readFileSync(fixesPath, "utf-8"));
		expect(fixes).toEqual([]);
	});

	it("handles missing state dir gracefully", () => {
		rmSync(STATE_DIR, { recursive: true, force: true });
		resetMcpCache();

		// Should not throw (fail-open)
		const result = handleTool("clear_pending_fixes", TEST_DIR, {
			reason: "Testing graceful handling of missing state",
		});
		expect(result.content[0]!.text).toContain("cleared");
	});

	it("requires reason parameter", () => {
		const result = handleTool("clear_pending_fixes", TEST_DIR, {});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("reason");
	});

	it("rejects short reason", () => {
		const result = handleTool("clear_pending_fixes", TEST_DIR, { reason: "short" });
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("10 chars");
	});

	it("writes audit log entry", () => {
		const fixesPath = join(STATE_DIR, "pending-fixes.json");
		writeFileSync(fixesPath, JSON.stringify([]));
		resetMcpCache();

		handleTool("clear_pending_fixes", TEST_DIR, {
			reason: "All fixes are false positives",
		});

		const auditLog = JSON.parse(readFileSync(join(STATE_DIR, "audit-log.json"), "utf-8"));
		expect(auditLog).toHaveLength(1);
		expect(auditLog[0].action).toBe("clear_pending_fixes");
		expect(auditLog[0].reason).toBe("All fixes are false positives");
	});
});

describe("handleTool: set_config", () => {
	it("sets a valid config key", () => {
		const qultDir = join(TEST_DIR, ".qult");
		mkdirSync(qultDir, { recursive: true });
		resetMcpCache();

		const result = handleTool("set_config", TEST_DIR, {
			key: "review.score_threshold",
			value: 10,
		});
		expect(result.content[0]!.text).toContain("Config set");
		expect(result.content[0]!.text).toContain("10");

		const config = JSON.parse(readFileSync(join(qultDir, "config.json"), "utf-8"));
		expect(config.review.score_threshold).toBe(10);
	});

	it("rejects invalid config key", () => {
		const result = handleTool("set_config", TEST_DIR, {
			key: "invalid.key",
			value: 5,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Invalid key");
	});

	it("returns error without key or value", () => {
		const noKey = handleTool("set_config", TEST_DIR, { value: 5 });
		expect(noKey.isError).toBe(true);
		const noValue = handleTool("set_config", TEST_DIR, { key: "review.score_threshold" });
		expect(noValue.isError).toBe(true);
	});

	it("merges with existing config", () => {
		const qultDir = join(TEST_DIR, ".qult");
		mkdirSync(qultDir, { recursive: true });
		writeFileSync(
			join(qultDir, "config.json"),
			JSON.stringify({ review: { score_threshold: 12, max_iterations: 3 } }),
		);
		resetMcpCache();

		handleTool("set_config", TEST_DIR, { key: "review.score_threshold", value: 10 });

		const config = JSON.parse(readFileSync(join(qultDir, "config.json"), "utf-8"));
		expect(config.review.score_threshold).toBe(10);
		expect(config.review.max_iterations).toBe(3);
	});
});

describe("handleTool: record_review", () => {
	it("sets review_completed_at in session state", () => {
		resetMcpCache();

		const result = handleTool("record_review", TEST_DIR);
		expect(result.content[0]!.text).toContain("recorded");

		const stateFile = findLatestStateFile(TEST_DIR, "session-state");
		const state = JSON.parse(readFileSync(stateFile, "utf-8"));
		expect(state.review_completed_at).toBeTruthy();
		expect(typeof state.review_completed_at).toBe("string");
	});

	it("includes aggregate score in response", () => {
		resetMcpCache();

		const result = handleTool("record_review", TEST_DIR, { aggregate_score: 26 });
		expect(result.content[0]!.text).toContain("recorded");
		expect(result.content[0]!.text).toContain("26");
	});

	it("refuses when plan required but missing", () => {
		resetMcpCache();

		// Set up session state with 6+ changed files (exceeds default threshold of 5)
		const stateFile = findLatestStateFile(TEST_DIR, "session-state");
		writeFileSync(
			stateFile,
			JSON.stringify({
				changed_file_paths: ["/a.ts", "/b.ts", "/c.ts", "/d.ts", "/e.ts", "/f.ts"],
			}),
		);
		resetMcpCache();

		const result = handleTool("record_review", TEST_DIR, { aggregate_score: 28 });
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("plan");
	});

	it("succeeds when plan exists despite many changed files", () => {
		resetMcpCache();

		// Set up session state with 6+ changed files
		const stateFile = findLatestStateFile(TEST_DIR, "session-state");
		writeFileSync(
			stateFile,
			JSON.stringify({
				changed_file_paths: ["/a.ts", "/b.ts", "/c.ts", "/d.ts", "/e.ts", "/f.ts"],
			}),
		);

		// Create a plan file
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(join(planDir, "test-plan.md"), "## Tasks\n### Task 1: test [done]\n");
		resetMcpCache();

		const result = handleTool("record_review", TEST_DIR, { aggregate_score: 28 });
		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("recorded");
	});
});

describe("handleTool: record_test_pass", () => {
	it("sets test_passed_at and test_command in session state", () => {
		resetMcpCache();

		const result = handleTool("record_test_pass", TEST_DIR, { command: "bun vitest run" });
		expect(result.content[0]!.text).toContain("Test pass recorded");

		const stateFile = findLatestStateFile(TEST_DIR, "session-state");
		const state = JSON.parse(readFileSync(stateFile, "utf-8"));
		expect(state.test_passed_at).toBeTruthy();
		expect(state.test_command).toBe("bun vitest run");
	});

	it("returns error without command", () => {
		const result = handleTool("record_test_pass", TEST_DIR, {});
		expect(result.isError).toBe(true);
	});
});

describe("handleTool: record_stage_scores", () => {
	it("records scores for a valid stage", () => {
		resetMcpCache();

		const result = handleTool("record_stage_scores", TEST_DIR, {
			stage: "Spec",
			scores: { completeness: 5, accuracy: 4 },
		});
		expect(result.content[0]!.text).toContain("Spec");

		const stateFile = findLatestStateFile(TEST_DIR, "session-state");
		const state = JSON.parse(readFileSync(stateFile, "utf-8"));
		expect(state.review_stage_scores.Spec).toEqual({ completeness: 5, accuracy: 4 });
	});

	it("rejects invalid stage name", () => {
		const result = handleTool("record_stage_scores", TEST_DIR, {
			stage: "Invalid",
			scores: { foo: 3 },
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Invalid stage");
	});

	it("returns error without required params", () => {
		expect(handleTool("record_stage_scores", TEST_DIR, {}).isError).toBe(true);
		expect(handleTool("record_stage_scores", TEST_DIR, { stage: "Spec" }).isError).toBe(true);
	});
});
