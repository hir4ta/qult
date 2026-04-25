import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../config.ts";
import { handleRequest, handleTool, TOOL_DEFS } from "../mcp-server.ts";
import { readAuditLog } from "../state/audit-log.ts";
import { listDisabledGateNames } from "../state/gate-state.ts";
import {
	appendPendingFix,
	readCurrent,
	readPendingFixes,
	readStageScores,
} from "../state/json-state.ts";
import { setProjectRoot } from "../state/paths.ts";

let TEST_DIR: string;
const originalCwd = process.cwd();

function initRepo(root: string): void {
	execSync("git init -q", { cwd: root });
	execSync("git config user.email t@t", { cwd: root });
	execSync("git config user.name t", { cwd: root });
	// Disable signing in test repo (host may have signing key + agent prompts).
	execSync("git config commit.gpgsign false", { cwd: root });
	execSync("git config tag.gpgsign false", { cwd: root });
	execSync("git commit -q --allow-empty -m init", { cwd: root });
}

beforeEach(() => {
	TEST_DIR = mkdtempSync(join(tmpdir(), "qult-mcp-"));
	mkdirSync(join(TEST_DIR, ".qult"), { recursive: true });
	setProjectRoot(TEST_DIR);
	resetConfigCache();
	process.chdir(TEST_DIR);
	initRepo(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	setProjectRoot(null);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("TOOL_DEFS", () => {
	it("each tool has name, description, and inputSchema", () => {
		expect(TOOL_DEFS.length).toBeGreaterThan(0);
		for (const def of TOOL_DEFS) {
			expect(typeof def.name).toBe("string");
			expect(def.name).toMatch(/^[a-z_]+$/);
			expect(typeof def.description).toBe("string");
			expect(def.description.length).toBeGreaterThan(0);
			expect(def.inputSchema.type).toBe("object");
		}
	});

	it("contains both legacy and new tool names", () => {
		const names = TOOL_DEFS.map((t) => t.name);
		expect(names).toContain("get_pending_fixes");
		expect(names).toContain("get_project_status");
		expect(names).toContain("disable_gate");
		expect(names).toContain("enable_gate");
		expect(names).toContain("record_test_pass");
		expect(names).toContain("record_review");
		// New spec tools
		expect(names).toContain("get_active_spec");
		expect(names).toContain("complete_wave");
		expect(names).toContain("update_task_status");
		expect(names).toContain("archive_spec");
		expect(names).toContain("record_spec_evaluator_score");
		// Removed
		expect(names).not.toContain("get_session_status");
		expect(names).not.toContain("archive_plan");
	});
});

describe("handleRequest (JSON-RPC)", () => {
	it("initialize returns server info", () => {
		const response = handleRequest(
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
			TEST_DIR,
		);
		const result = response!.result as Record<string, unknown>;
		expect(result.protocolVersion).toBe("2024-11-05");
		expect((result.serverInfo as Record<string, string>).name).toBe("qult");
	});

	it("tools/list returns the full tool catalog", () => {
		const response = handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, TEST_DIR);
		const result = response!.result as { tools: { name: string }[] };
		expect(result.tools.length).toBe(TOOL_DEFS.length);
	});

	it("tools/call dispatches to handler", () => {
		const response = handleRequest(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "get_pending_fixes", arguments: {} },
			},
			TEST_DIR,
		);
		expect(response!.result).toBeDefined();
	});

	it("ping returns empty result", () => {
		const response = handleRequest({ jsonrpc: "2.0", id: 4, method: "ping" }, TEST_DIR);
		expect(response!.result).toBeDefined();
	});

	it("returns -32601 for unknown method", () => {
		const response = handleRequest({ jsonrpc: "2.0", id: 5, method: "no_such_method" }, TEST_DIR);
		expect(response!.error?.code).toBe(-32601);
	});
});

describe("handleTool: read", () => {
	it("get_pending_fixes returns 'No pending fixes.' on empty", () => {
		const r = handleTool("get_pending_fixes", TEST_DIR);
		expect(r.content[0]!.text).toBe("No pending fixes.");
	});

	it("get_pending_fixes returns formatted entries when populated", () => {
		appendPendingFix({
			id: "1",
			detector: "security-check",
			severity: "high",
			file: join(TEST_DIR, "src/foo.ts"),
			line: 5,
			message: "hardcoded secret",
			created_at: "2026-04-25T00:00:00Z",
		});
		const r = handleTool("get_pending_fixes", TEST_DIR);
		expect(r.content[0]!.text).toMatch(/security-check/);
		expect(r.content[0]!.text).toMatch(/hardcoded secret/);
	});

	it("get_project_status returns active_spec=null when no spec", () => {
		const r = handleTool("get_project_status", TEST_DIR);
		const parsed = JSON.parse(r.content[0]!.text);
		expect(parsed.active_spec).toBeNull();
		expect(parsed.test_passed_at).toBeNull();
		expect(parsed.review_completed_at).toBeNull();
	});

	it("get_project_status surfaces active_spec from filesystem", () => {
		mkdirSync(join(TEST_DIR, ".qult", "specs", "demo"), { recursive: true });
		writeFileSync(join(TEST_DIR, ".qult", "specs", "demo", "requirements.md"), "x");
		const r = handleTool("get_project_status", TEST_DIR);
		const parsed = JSON.parse(r.content[0]!.text);
		expect(parsed.active_spec.name).toBe("demo");
		expect(parsed.active_spec.has_requirements).toBe(true);
	});
});

describe("handleTool: record / write", () => {
	it("record_test_pass updates current.json", () => {
		handleTool("record_test_pass", TEST_DIR, { command: "bun test" });
		const cur = readCurrent();
		expect(cur.test_command).toBe("bun test");
		expect(cur.test_passed_at).not.toBeNull();
	});

	it("record_review updates current.json with score", () => {
		handleTool("record_review", TEST_DIR, { aggregate_score: 32 });
		const cur = readCurrent();
		expect(cur.review_score).toBe(32);
		expect(cur.review_completed_at).not.toBeNull();
	});

	it("record_human_approval rejects without prior review", () => {
		const r = handleTool("record_human_approval", TEST_DIR);
		expect(r.isError).toBe(true);
	});

	it("record_human_approval rejects without test pass", () => {
		handleTool("record_review", TEST_DIR, { aggregate_score: 30 });
		const r = handleTool("record_human_approval", TEST_DIR);
		expect(r.isError).toBe(true);
		expect(r.content[0]!.text).toMatch(/test pass/);
	});

	it("record_human_approval succeeds after both record_test_pass and record_review", () => {
		handleTool("record_test_pass", TEST_DIR, { command: "bun test" });
		handleTool("record_review", TEST_DIR, { aggregate_score: 30 });
		const r = handleTool("record_human_approval", TEST_DIR);
		expect(r.isError).toBeFalsy();
		expect(readCurrent().human_approval_at).not.toBeNull();
	});

	it("record_finish_started writes timestamp", () => {
		handleTool("record_finish_started", TEST_DIR);
		expect(readCurrent().finish_started_at).not.toBeNull();
	});

	it("record_stage_scores writes per-stage scores", () => {
		handleTool("record_stage_scores", TEST_DIR, {
			stage: "Spec",
			scores: { completeness: 4, accuracy: 5 },
		});
		const s = readStageScores();
		expect(s.review.Spec?.scores).toEqual({ completeness: 4, accuracy: 5 });
	});

	it("record_stage_scores rejects invalid stage", () => {
		const r = handleTool("record_stage_scores", TEST_DIR, {
			stage: "BogusStage",
			scores: {},
		});
		expect(r.isError).toBe(true);
	});
});

describe("handleTool: gate state", () => {
	it("disable_gate persists to gate-state.json", () => {
		handleTool("disable_gate", TEST_DIR, {
			gate_name: "review",
			reason: "Misconfigured for current task",
		});
		expect(listDisabledGateNames()).toContain("review");
	});

	it("disable_gate writes audit entry", () => {
		handleTool("disable_gate", TEST_DIR, {
			gate_name: "review",
			reason: "Need to bypass for documentation-only branch",
		});
		const log = readAuditLog();
		expect(log.find((e) => e.action === "disable_gate")).toBeTruthy();
	});

	it("disable_gate rejects when 2 gates already disabled", async () => {
		const { disableGate } = await import("../state/gate-state.ts");
		disableGate("review", "first reason here");
		disableGate("security-check", "second reason here");
		const r = handleTool("disable_gate", TEST_DIR, {
			gate_name: "test-quality-check",
			reason: "trying to disable a third gate",
		});
		expect(r.isError).toBe(true);
		expect(r.content[0]!.text).toMatch(/Maximum 2/);
	});

	it("disable_gate rejects unknown gate", () => {
		const r = handleTool("disable_gate", TEST_DIR, {
			gate_name: "bogus-gate-name",
			reason: "still need a long enough reason",
		});
		expect(r.isError).toBe(true);
	});

	it("enable_gate removes gate from disabled state", async () => {
		const { disableGate } = await import("../state/gate-state.ts");
		disableGate("lint", "test reason here");
		handleTool("enable_gate", TEST_DIR, { gate_name: "lint" });
		expect(listDisabledGateNames()).not.toContain("lint");
	});
});

describe("handleTool: clear_pending_fixes", () => {
	it("requires reason >= 10 chars", () => {
		const r = handleTool("clear_pending_fixes", TEST_DIR, { reason: "short" });
		expect(r.isError).toBe(true);
	});

	it("clears all fixes", () => {
		appendPendingFix({
			id: "1",
			detector: "test",
			severity: "low",
			file: "x",
			line: null,
			message: "x",
			created_at: "now",
		});
		expect(readPendingFixes().fixes).toHaveLength(1);
		handleTool("clear_pending_fixes", TEST_DIR, { reason: "All resolved offline" });
		expect(readPendingFixes().fixes).toHaveLength(0);
	});

	it("writes audit entry on clear", () => {
		handleTool("clear_pending_fixes", TEST_DIR, { reason: "Cleared after release" });
		const log = readAuditLog();
		expect(log.find((e) => e.action === "clear_pending_fixes")).toBeTruthy();
	});
});

describe("handleTool: set_config", () => {
	it("rejects invalid keys", () => {
		const r = handleTool("set_config", TEST_DIR, { key: "bogus.key", value: 1 });
		expect(r.isError).toBe(true);
	});

	it("rejects mismatched value type for boolean key", () => {
		const r = handleTool("set_config", TEST_DIR, {
			key: "review.require_human_approval",
			value: 1,
		});
		expect(r.isError).toBe(true);
	});

	it("writes a numeric key to config.json", () => {
		const r = handleTool("set_config", TEST_DIR, {
			key: "review.score_threshold",
			value: 35,
		});
		expect(r.isError).toBeFalsy();
		expect(r.content[0]!.text).toMatch(/Config set/);
	});
});

describe("handleTool: errors", () => {
	it("returns isError for unknown tool name", () => {
		const r = handleTool("no_such_tool", TEST_DIR);
		expect(r.isError).toBe(true);
		expect(r.content[0]!.text).toMatch(/Unknown tool/);
	});
});
