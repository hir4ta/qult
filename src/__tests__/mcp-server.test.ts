import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRequest, handleTool, TOOL_DEFS } from "../mcp-server.ts";
import { closeDb, getDb, getProjectId, setProjectPath, useTestDb } from "../state/db.ts";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-mcp-test");
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(TEST_DIR, { recursive: true });
	useTestDb();
	setProjectPath(TEST_DIR);
	process.chdir(TEST_DIR);
});

afterEach(() => {
	process.chdir(originalCwd);
	closeDb();
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("handleTool", () => {
	it("get_pending_fixes returns empty message when no fixes", () => {
		const result = handleTool("get_pending_fixes", TEST_DIR);
		expect(result.content[0]!.text).toBe("No pending fixes.");
	});

	it("get_pending_fixes returns formatted fixes from DB", () => {
		const db = getDb();
		db.prepare(
			"INSERT INTO pending_fixes (project_id, file, gate, errors) VALUES (?, ?, ?, ?)",
		).run(getProjectId(), "/src/foo.ts", "lint", JSON.stringify(["error: unused var"]));

		const result = handleTool("get_pending_fixes", TEST_DIR);
		const text = result.content[0]!.text;
		expect(text).toContain("1 pending fix(es)");
		expect(text).toContain("[lint] /src/foo.ts");
		expect(text).toContain("error: unused var");
	});

	it("get_session_status returns state from DB", () => {
		const db = getDb();
		db.prepare("UPDATE projects SET last_commit_at = ? WHERE id = ?").run(
			"2026-01-01T00:00:00Z",
			getProjectId(),
		);

		const result = handleTool("get_session_status", TEST_DIR);
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.last_commit_at).toBe("2026-01-01T00:00:00Z");
		expect(parsed.test_passed_at).toBeNull();
	});

	it("get_session_status returns project state", () => {
		const result = handleTool("get_session_status", TEST_DIR);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("id");
	});

	it("write tools work with an active project", () => {
		// Project is auto-created by setProjectPath + getProjectId

		const writeCases: [string, Record<string, unknown>][] = [
			["record_review", { aggregate_score: 30 }],
			["record_test_pass", { command: "bun test" }],
			["disable_gate", { gate_name: "lint", reason: "broken gate temporarily" }],
			["clear_pending_fixes", { reason: "all fixes resolved" }],
			["record_human_approval", {}],
		];
		for (const [tool, args] of writeCases) {
			const result = handleTool(tool, TEST_DIR, args);
			// With project-based state, write tools always work (project auto-created)
			expect(result.content).toBeDefined();
		}
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

	it("tools/list returns tool definitions", () => {
		const response = handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, TEST_DIR);
		const result = response!.result as { tools: { name: string }[] };
		const names = result.tools.map((t) => t.name);
		expect(names).toContain("get_pending_fixes");
		expect(names).toContain("get_session_status");
		expect(names).toContain("disable_gate");
		expect(names).toContain("record_test_pass");
		expect(names).toContain("record_review");
		expect(names).not.toContain("get_gate_config");
		expect(names).not.toContain("save_gates");
		expect(names).not.toContain("get_harness_report");
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
	it("has at least one tool definition", () => {
		expect(TOOL_DEFS.length).toBeGreaterThan(0);
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
	it("disable_gate adds detector gate to disabled_gates in DB", () => {
		const db = getDb();
		const result = handleTool("disable_gate", TEST_DIR, {
			gate_name: "security-check",
			reason: "False positives on this codebase",
		});
		expect(result.content[0]!.text).toContain("disabled");

		const rows = db
			.prepare("SELECT gate_name FROM disabled_gates WHERE project_id = ?")
			.all(getProjectId()) as { gate_name: string }[];
		expect(rows.map((r) => r.gate_name)).toContain("security-check");
	});

	it("disable_gate rejects unknown gate name", () => {
		const result = handleTool("disable_gate", TEST_DIR, {
			gate_name: "typo",
			reason: "Testing unknown gate rejection",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Unknown gate");
	});

	it("disable_gate accepts 'review' as valid gate name", () => {
		const result = handleTool("disable_gate", TEST_DIR, {
			gate_name: "review",
			reason: "Review not needed for documentation changes",
		});
		expect(result.content[0]!.text).toContain("disabled");
	});

	it("disable_gate accepts security-check gate name", () => {
		const secResult = handleTool("disable_gate", TEST_DIR, {
			gate_name: "security-check",
			reason: "Security patterns causing false positives",
		});
		expect(secResult.content[0]!.text).toContain("disabled");
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
		const db = getDb();
		db.prepare("INSERT INTO disabled_gates (project_id, gate_name, reason) VALUES (?, ?, ?)").run(
			getProjectId(),
			"review",
			"test reason 1 for review",
		);
		db.prepare("INSERT INTO disabled_gates (project_id, gate_name, reason) VALUES (?, ?, ?)").run(
			getProjectId(),
			"security-check",
			"test reason 2 for security",
		);

		const result = handleTool("disable_gate", TEST_DIR, {
			gate_name: "test-quality-check",
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

		const db = getDb();
		const projectId = getProjectId();
		const rows = db
			.prepare("SELECT action, gate_name FROM audit_log WHERE project_id = ?")
			.all(projectId) as { action: string; gate_name: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.action).toBe("disable_gate");
		expect(rows[0]!.gate_name).toBe("review");
	});

	it("enable_gate removes gate from disabled_gates", () => {
		const db = getDb();
		db.prepare("INSERT INTO disabled_gates (project_id, gate_name, reason) VALUES (?, ?, ?)").run(
			getProjectId(),
			"lint",
			"test reason for lint",
		);
		db.prepare("INSERT INTO disabled_gates (project_id, gate_name, reason) VALUES (?, ?, ?)").run(
			getProjectId(),
			"typecheck",
			"test reason for typecheck",
		);

		const result = handleTool("enable_gate", TEST_DIR, { gate_name: "lint" });
		expect(result.content[0]!.text).toContain("re-enabled");

		const rows = db
			.prepare("SELECT gate_name FROM disabled_gates WHERE project_id = ?")
			.all(getProjectId()) as { gate_name: string }[];
		expect(rows.map((r) => r.gate_name)).toEqual(["typecheck"]);
	});

	it("disable_gate returns error without gate_name", () => {
		const result = handleTool("disable_gate", TEST_DIR, { reason: "Testing missing gate_name" });
		expect(result.isError).toBe(true);
	});
});

describe("handleTool: clear_pending_fixes", () => {
	it("clears all pending fixes", () => {
		const db = getDb();
		db.prepare(
			"INSERT INTO pending_fixes (project_id, file, gate, errors) VALUES (?, ?, ?, ?)",
		).run(getProjectId(), "a.ts", "lint", JSON.stringify(["err"]));

		const result = handleTool("clear_pending_fixes", TEST_DIR, {
			reason: "False positives from linter update",
		});
		expect(result.content[0]!.text).toContain("cleared");

		const rows = db.prepare("SELECT * FROM pending_fixes WHERE project_id = ?").all(getProjectId());
		expect(rows).toEqual([]);
	});

	it("handles empty state gracefully", () => {
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
		handleTool("clear_pending_fixes", TEST_DIR, {
			reason: "All fixes are false positives",
		});

		const db = getDb();
		const projectId = getProjectId();
		const rows = db
			.prepare("SELECT action, reason FROM audit_log WHERE project_id = ?")
			.all(projectId) as { action: string; reason: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.action).toBe("clear_pending_fixes");
		expect(rows[0]!.reason).toBe("All fixes are false positives");
	});
});

describe("handleTool: set_config", () => {
	it("sets a valid config key", () => {
		const result = handleTool("set_config", TEST_DIR, {
			key: "review.score_threshold",
			value: 10,
		});
		expect(result.content[0]!.text).toContain("Config set");
		expect(result.content[0]!.text).toContain("10");

		const db = getDb();
		const projectId = getProjectId();
		const row = db
			.prepare("SELECT value FROM project_configs WHERE project_id = ? AND key = ?")
			.get(projectId, "review.score_threshold") as { value: string };
		expect(JSON.parse(row.value)).toBe(10);
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
});

describe("handleTool: record_review", () => {
	it("sets review_completed_at in session state", () => {
		const result = handleTool("record_review", TEST_DIR);
		expect(result.content[0]!.text).toContain("recorded");

		const db = getDb();
		const row = db
			.prepare("SELECT review_completed_at FROM projects WHERE id = ?")
			.get(getProjectId()) as {
			review_completed_at: string | null;
		};
		expect(row.review_completed_at).toBeTruthy();
		expect(typeof row.review_completed_at).toBe("string");
	});

	it("includes aggregate score in response", () => {
		const result = handleTool("record_review", TEST_DIR, { aggregate_score: 26 });
		expect(result.content[0]!.text).toContain("recorded");
		expect(result.content[0]!.text).toContain("26");
	});

	it("succeeds when many files changed without a plan", () => {
		const db = getDb();
		// Insert 6+ changed files (exceeds default threshold of 5)
		for (const f of ["/a.ts", "/b.ts", "/c.ts", "/d.ts", "/e.ts", "/f.ts"]) {
			db.prepare("INSERT INTO changed_files (project_id, file_path) VALUES (?, ?)").run(
				getProjectId(),
				f,
			);
		}

		const result = handleTool("record_review", TEST_DIR, { aggregate_score: 28 });
		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("recorded");
	});
});

describe("handleTool: record_test_pass", () => {
	it("sets test_passed_at and test_command in session state", () => {
		const result = handleTool("record_test_pass", TEST_DIR, { command: "bun vitest run" });
		expect(result.content[0]!.text).toContain("Test pass recorded");

		const db = getDb();
		const row = db
			.prepare("SELECT test_passed_at, test_command FROM projects WHERE id = ?")
			.get(getProjectId()) as {
			test_passed_at: string | null;
			test_command: string | null;
		};
		expect(row.test_passed_at).toBeTruthy();
		expect(row.test_command).toBe("bun vitest run");
	});

	it("returns error without command", () => {
		const result = handleTool("record_test_pass", TEST_DIR, {});
		expect(result.isError).toBe(true);
	});
});

describe("handleTool: record_stage_scores", () => {
	it("records scores for a valid stage", () => {
		const result = handleTool("record_stage_scores", TEST_DIR, {
			stage: "Spec",
			scores: { completeness: 5, accuracy: 4 },
		});
		expect(result.content[0]!.text).toContain("Spec");

		const db = getDb();
		const rows = db
			.prepare("SELECT stage, dimension, score FROM review_stage_scores WHERE project_id = ?")
			.all(getProjectId()) as { stage: string; dimension: string; score: number }[];
		const scoreMap: Record<string, number> = {};
		for (const r of rows) scoreMap[r.dimension] = r.score;
		expect(scoreMap).toEqual({ completeness: 5, accuracy: 4 });
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

describe("record_human_approval", () => {
	it("records approval timestamp in session state", () => {
		const db = getDb();
		db.prepare("UPDATE projects SET review_completed_at = ? WHERE id = ?").run(
			new Date().toISOString(),
			getProjectId(),
		);

		const result = handleTool("record_human_approval", TEST_DIR);
		expect(result.content[0]!.text).toContain("Human approval recorded");

		const row = db
			.prepare("SELECT human_review_approved_at FROM projects WHERE id = ?")
			.get(getProjectId()) as {
			human_review_approved_at: string | null;
		};
		expect(typeof row.human_review_approved_at).toBe("string");
		expect(row.human_review_approved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("rejects when no review has been completed", () => {
		const result = handleTool("record_human_approval", TEST_DIR);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("no review");
	});
});

describe("get_detector_summary", () => {
	it("returns 'No detector findings.' on clean state", () => {
		const result = handleTool("get_detector_summary", TEST_DIR);
		expect(result.content[0]!.text).toBe("No detector findings.");
	});

	it("returns summary when security warnings and pending fixes exist", () => {
		const db = getDb();
		db.prepare("UPDATE projects SET security_warning_count = ? WHERE id = ?").run(
			3,
			getProjectId(),
		);
		db.prepare(
			"INSERT INTO pending_fixes (project_id, file, gate, errors) VALUES (?, ?, ?, ?)",
		).run(
			getProjectId(),
			"src/foo.ts",
			"security-check",
			JSON.stringify(["L5: Hardcoded API key"]),
		);

		const result = handleTool("get_detector_summary", TEST_DIR);
		const text = result.content[0]!.text;
		expect(text).toContain("security_warning_count: 3");
		expect(text).toContain("security-check");
		expect(text).toContain("src/foo.ts");
	});

	it("includes all non-zero escalation counters", () => {
		const db = getDb();
		db.prepare(
			"UPDATE projects SET dead_import_warning_count = ?, drift_warning_count = ?, test_quality_warning_count = ?, duplication_warning_count = ? WHERE id = ?",
		).run(2, 4, 1, 3, getProjectId());

		const result = handleTool("get_detector_summary", TEST_DIR);
		const text = result.content[0]!.text;
		expect(text).toContain("dead_import_warning_count: 2");
		expect(text).toContain("drift_warning_count: 4");
		expect(text).toContain("test_quality_warning_count: 1");
		expect(text).toContain("duplication_warning_count: 3");
	});
});

describe("archive_plan", () => {
	it("archive_plan tool moves plan file to archive", () => {
		const plansDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(plansDir, { recursive: true });
		const planPath = join(plansDir, "test-plan.md");
		writeFileSync(planPath, "# Plan\n## Tasks\n### Task 1: Test [done]");

		const result = handleTool("archive_plan", TEST_DIR, { plan_path: planPath });
		expect(result.content[0]!.text).toContain("archived");
		expect(existsSync(planPath)).toBe(false);
		expect(existsSync(join(plansDir, "archive", "test-plan.md"))).toBe(true);
	});

	it("returns 'not found' for non-existent plan path under .claude/plans/", () => {
		const plansDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(plansDir, { recursive: true });
		const fakePath = join(plansDir, "non-existent.md");
		const result = handleTool("archive_plan", TEST_DIR, { plan_path: fakePath });
		expect(result.content[0]!.text).toContain("not found");
	});

	it("rejects path traversal attempts", () => {
		const maliciousPath = "/etc/passwd";
		const result = handleTool("archive_plan", TEST_DIR, { plan_path: maliciousPath });
		expect(result.content[0]!.text).toContain("Error");
	});

	it("rejects non-.md file paths", () => {
		const plansDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(plansDir, { recursive: true });
		const nonMdPath = join(plansDir, "malicious.sh");
		writeFileSync(nonMdPath, "#!/bin/bash");
		const result = handleTool("archive_plan", TEST_DIR, { plan_path: nonMdPath });
		expect(result.content[0]!.text).toContain("Error");
	});
});

describe("get_file_health_score", () => {
	it("returns score for clean file", () => {
		const file = join(TEST_DIR, "clean.ts");
		writeFileSync(file, "export const x = 1;\n");
		const result = handleTool("get_file_health_score", TEST_DIR, { file_path: file });
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.score).toBe(10);
		expect(parsed.breakdown).toEqual({});
	});

	it("returns 10 for nonexistent file (fail-open)", () => {
		const result = handleTool("get_file_health_score", TEST_DIR, {
			file_path: "/nonexistent/path.ts",
		});
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.score).toBe(10);
		expect(parsed.breakdown).toEqual({});
	});

	it("rejects path outside project directory", () => {
		const result = handleTool("get_file_health_score", TEST_DIR, {
			file_path: "/etc/passwd",
		});
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.error).toBeDefined();
	});
});

describe("record_finish_started", () => {
	it("persists to DB so hooks can read it via wasFinishStarted", async () => {
		handleTool("record_finish_started", TEST_DIR, {});

		// Reset ALL caches to simulate a fresh hook process
		const { resetAllCaches } = await import("../state/flush.ts");
		resetAllCaches();

		// wasFinishStarted reads from DB via readSessionState — must see the marker
		const { wasFinishStarted } = await import("../state/session-state.ts");
		expect(wasFinishStarted()).toBe(true);
	});
});

describe("get_impact_analysis", () => {
	it("returns consumer list", () => {
		// Create files with import relationship
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		const target = join(TEST_DIR, "src", "utils.ts");
		const consumer = join(TEST_DIR, "src", "app.ts");
		writeFileSync(target, "export const foo = 1;");
		writeFileSync(consumer, 'import { foo } from "./utils";');

		const result = handleTool("get_impact_analysis", TEST_DIR, { file: target });
		const text = result.content[0]!.text;
		const parsed = JSON.parse(text);
		expect(parsed.consumers).toContain(consumer);
	});

	it("returns empty consumers when no importers", () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		const target = join(TEST_DIR, "src", "lonely.ts");
		writeFileSync(target, "export const x = 1;");

		const result = handleTool("get_impact_analysis", TEST_DIR, { file: target });
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.consumers).toEqual([]);
	});
});

describe("get_call_coverage", () => {
	it("checks test-to-impl path", () => {
		mkdirSync(join(TEST_DIR, "src", "__tests__"), { recursive: true });
		const impl = join(TEST_DIR, "src", "utils.ts");
		const test = join(TEST_DIR, "src", "__tests__", "utils.test.ts");
		writeFileSync(impl, "export function doStuff() {}");
		writeFileSync(test, 'import { doStuff } from "../utils";\nit("works", () => { doStuff(); });');

		const result = handleTool("get_call_coverage", TEST_DIR, {
			test_file: test,
			impl_file: impl,
		});
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.covered).toBe(true);
	});

	it("returns false when test does not import impl", () => {
		mkdirSync(join(TEST_DIR, "src", "__tests__"), { recursive: true });
		const impl = join(TEST_DIR, "src", "utils.ts");
		const test = join(TEST_DIR, "src", "__tests__", "other.test.ts");
		writeFileSync(impl, "export function doStuff() {}");
		writeFileSync(test, 'it("works", () => { expect(1).toBe(1); });');

		const result = handleTool("get_call_coverage", TEST_DIR, {
			test_file: test,
			impl_file: impl,
		});
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.covered).toBe(false);
	});
});

describe("instructions include impact analysis guidance", () => {
	it("instructions mention get_impact_analysis", () => {
		const req = handleRequest(
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
			TEST_DIR,
		);
		const result = req as { result?: { instructions?: string } };
		expect(result.result?.instructions).toContain("get_impact_analysis");
	});
});

describe("dep-vuln-check and hallucinated-package-check gate names", () => {
	it("disable_gate accepts dep-vuln-check", () => {
		const result = handleTool("disable_gate", TEST_DIR, {
			gate_name: "dep-vuln-check",
			reason: "Not needed for this testing session",
		});
		expect(result.content[0]!.text).toContain("disabled");
	});

	it("disable_gate accepts hallucinated-package-check", () => {
		const result = handleTool("disable_gate", TEST_DIR, {
			gate_name: "hallucinated-package-check",
			reason: "Not needed for this testing session",
		});
		expect(result.content[0]!.text).toContain("disabled");
	});
});
