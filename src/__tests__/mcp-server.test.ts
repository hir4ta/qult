import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRequest, handleTool, TOOL_DEFS } from "../mcp-server.ts";
import {
	closeDb,
	ensureSession,
	getDb,
	getProjectId,
	getSessionId,
	setProjectPath,
	setSessionScope,
	useTestDb,
} from "../state/db.ts";
import { resetAllCaches } from "../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-mcp-test");
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(TEST_DIR, { recursive: true });
	useTestDb();
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
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
		const sid = getSessionId();
		db.prepare(
			"INSERT INTO pending_fixes (session_id, file, gate, errors) VALUES (?, ?, ?, ?)",
		).run(sid, "/src/foo.ts", "lint", JSON.stringify(["error: unused var"]));

		const result = handleTool("get_pending_fixes", TEST_DIR);
		const text = result.content[0]!.text;
		expect(text).toContain("1 pending fix(es)");
		expect(text).toContain("[lint] /src/foo.ts");
		expect(text).toContain("error: unused var");
	});

	it("get_session_status returns state from DB", () => {
		const db = getDb();
		const sid = getSessionId();
		db.prepare("UPDATE sessions SET last_commit_at = ? WHERE id = ?").run(
			"2026-01-01T00:00:00Z",
			sid,
		);

		const result = handleTool("get_session_status", TEST_DIR);
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.last_commit_at).toBe("2026-01-01T00:00:00Z");
		expect(parsed.test_passed_at).toBeNull();
	});

	it("get_session_status returns isError when no session", () => {
		// Delete the session so it's not found
		const db = getDb();
		db.prepare("DELETE FROM sessions").run();

		const result = handleTool("get_session_status", TEST_DIR);
		expect(result.content[0]!.text).toContain("No session state");
		expect(result.isError).toBe(true);
	});

	it("write tools return error when no active session exists", () => {
		// Delete all sessions to simulate no hook having ever run
		const db = getDb();
		db.prepare("DELETE FROM sessions").run();
		db.prepare("DELETE FROM projects").run();

		const writeCases: [string, Record<string, unknown>][] = [
			["record_review", { aggregate_score: 30 }],
			["record_test_pass", { command: "bun test" }],
			["disable_gate", { gate_name: "lint", reason: "broken gate temporarily" }],
			["clear_pending_fixes", { reason: "all fixes resolved" }],
			["record_human_approval", {}],
		];
		for (const [tool, args] of writeCases) {
			const result = handleTool(tool, TEST_DIR, args);
			expect(result.isError, `${tool} should return isError`).toBe(true);
			expect(result.content[0]!.text).toContain("No active session");
		}
	});

	it("read tools work even without an active session", () => {
		const db = getDb();
		db.prepare("DELETE FROM sessions").run();
		db.prepare("DELETE FROM projects").run();

		const result = handleTool("get_pending_fixes", TEST_DIR);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toBe("No pending fixes.");
	});

	it("get_gate_config returns gates from DB", () => {
		const db = getDb();
		const projectId = getProjectId();
		db.prepare(
			"INSERT INTO gate_configs (project_id, phase, gate_name, command) VALUES (?, ?, ?, ?)",
		).run(projectId, "on_write", "lint", "bun biome check {file}");
		db.prepare(
			"INSERT INTO gate_configs (project_id, phase, gate_name, command) VALUES (?, ?, ?, ?)",
		).run(projectId, "on_commit", "test", "bun vitest run");
		resetAllCaches();

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

	it("tools/list returns all tool definitions", () => {
		const response = handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, TEST_DIR);
		const result = response!.result as { tools: { name: string }[] };
		expect(result.tools).toHaveLength(20);
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
			"get_detector_summary",
			"record_human_approval",
			"record_stage_scores",
			"reset_escalation_counters",
			"get_harness_report",
			"get_handoff_document",
			"get_metrics_dashboard",
			"get_flywheel_recommendations",
			"record_finish_started",
			"archive_plan",
			"save_gates",
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
	it("has 20 tool definitions", () => {
		expect(TOOL_DEFS).toHaveLength(20);
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
	it("disable_gate adds gate to disabled_gates in DB", () => {
		const db = getDb();
		const projectId = getProjectId();
		db.prepare(
			"INSERT INTO gate_configs (project_id, phase, gate_name, command) VALUES (?, ?, ?, ?)",
		).run(projectId, "on_write", "lint", "echo ok");
		resetAllCaches();

		const result = handleTool("disable_gate", TEST_DIR, {
			gate_name: "lint",
			reason: "Gate is broken for this test session",
		});
		expect(result.content[0]!.text).toContain("disabled");

		const sid = getSessionId();
		const rows = db
			.prepare("SELECT gate_name FROM disabled_gates WHERE session_id = ?")
			.all(sid) as { gate_name: string }[];
		expect(rows.map((r) => r.gate_name)).toContain("lint");
	});

	it("disable_gate rejects unknown gate name", () => {
		const db = getDb();
		const projectId = getProjectId();
		db.prepare(
			"INSERT INTO gate_configs (project_id, phase, gate_name, command) VALUES (?, ?, ?, ?)",
		).run(projectId, "on_write", "lint", "echo ok");
		resetAllCaches();

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

	it("disable_gate accepts computational detector names (security-check, dead-import-check)", () => {
		const secResult = handleTool("disable_gate", TEST_DIR, {
			gate_name: "security-check",
			reason: "Security patterns causing false positives",
		});
		expect(secResult.content[0]!.text).toContain("disabled");

		// Re-enable security-check before disabling dead-import to stay under limit
		handleTool("enable_gate", TEST_DIR, { gate_name: "security-check" });

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
		const db = getDb();
		const sid = getSessionId();
		db.prepare("INSERT INTO disabled_gates (session_id, gate_name, reason) VALUES (?, ?, ?)").run(
			sid,
			"review",
			"test reason 1 for review",
		);
		db.prepare("INSERT INTO disabled_gates (session_id, gate_name, reason) VALUES (?, ?, ?)").run(
			sid,
			"security-check",
			"test reason 2 for security",
		);

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
		const sid = getSessionId();
		db.prepare("INSERT INTO disabled_gates (session_id, gate_name, reason) VALUES (?, ?, ?)").run(
			sid,
			"lint",
			"test reason for lint",
		);
		db.prepare("INSERT INTO disabled_gates (session_id, gate_name, reason) VALUES (?, ?, ?)").run(
			sid,
			"typecheck",
			"test reason for typecheck",
		);

		const result = handleTool("enable_gate", TEST_DIR, { gate_name: "lint" });
		expect(result.content[0]!.text).toContain("re-enabled");

		const rows = db
			.prepare("SELECT gate_name FROM disabled_gates WHERE session_id = ?")
			.all(sid) as { gate_name: string }[];
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
		const sid = getSessionId();
		db.prepare(
			"INSERT INTO pending_fixes (session_id, file, gate, errors) VALUES (?, ?, ?, ?)",
		).run(sid, "a.ts", "lint", JSON.stringify(["err"]));

		const result = handleTool("clear_pending_fixes", TEST_DIR, {
			reason: "False positives from linter update",
		});
		expect(result.content[0]!.text).toContain("cleared");

		const rows = db.prepare("SELECT * FROM pending_fixes WHERE session_id = ?").all(sid);
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
		const sid = getSessionId();
		const row = db.prepare("SELECT review_completed_at FROM sessions WHERE id = ?").get(sid) as {
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
		const sid = getSessionId();
		// Insert 6+ changed files (exceeds default threshold of 5)
		for (const f of ["/a.ts", "/b.ts", "/c.ts", "/d.ts", "/e.ts", "/f.ts"]) {
			db.prepare("INSERT INTO changed_files (session_id, file_path) VALUES (?, ?)").run(sid, f);
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
		const sid = getSessionId();
		const row = db
			.prepare("SELECT test_passed_at, test_command FROM sessions WHERE id = ?")
			.get(sid) as {
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
		const sid = getSessionId();
		const rows = db
			.prepare("SELECT stage, dimension, score FROM review_stage_scores WHERE session_id = ?")
			.all(sid) as { stage: string; dimension: string; score: number }[];
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
		const sid = getSessionId();
		db.prepare("UPDATE sessions SET review_completed_at = ? WHERE id = ?").run(
			new Date().toISOString(),
			sid,
		);

		const result = handleTool("record_human_approval", TEST_DIR);
		expect(result.content[0]!.text).toContain("Human approval recorded");

		const row = db
			.prepare("SELECT human_review_approved_at FROM sessions WHERE id = ?")
			.get(sid) as {
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
		const sid = getSessionId();
		db.prepare("UPDATE sessions SET security_warning_count = ? WHERE id = ?").run(3, sid);
		db.prepare(
			"INSERT INTO pending_fixes (session_id, file, gate, errors) VALUES (?, ?, ?, ?)",
		).run(sid, "src/foo.ts", "security-check", JSON.stringify(["L5: Hardcoded API key"]));

		const result = handleTool("get_detector_summary", TEST_DIR);
		const text = result.content[0]!.text;
		expect(text).toContain("security_warning_count: 3");
		expect(text).toContain("security-check");
		expect(text).toContain("src/foo.ts");
	});

	it("includes all non-zero escalation counters", () => {
		const db = getDb();
		const sid = getSessionId();
		db.prepare(
			"UPDATE sessions SET dead_import_warning_count = ?, drift_warning_count = ?, test_quality_warning_count = ?, duplication_warning_count = ? WHERE id = ?",
		).run(2, 4, 1, 3, sid);

		const result = handleTool("get_detector_summary", TEST_DIR);
		const text = result.content[0]!.text;
		expect(text).toContain("dead_import_warning_count: 2");
		expect(text).toContain("drift_warning_count: 4");
		expect(text).toContain("test_quality_warning_count: 1");
		expect(text).toContain("duplication_warning_count: 3");
	});
});

describe("handleTool: save_gates", () => {
	it("saves gates and returns count summary", () => {
		const gates = {
			on_write: {
				lint: { command: "biome check {file}", timeout: 3000 },
				typecheck: { command: "tsc --noEmit", timeout: 10000, run_once_per_batch: true },
			},
			on_commit: {
				test: { command: "vitest run", timeout: 30000 },
			},
		};
		const result = handleTool("save_gates", TEST_DIR, { gates });
		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("Gates saved");
		expect(result.content[0]!.text).toContain("2 on_write");
		expect(result.content[0]!.text).toContain("1 on_commit");
	});

	it("gates are readable via get_gate_config after save", () => {
		const gates = {
			on_write: { lint: { command: "biome check {file}" } },
		};
		handleTool("save_gates", TEST_DIR, { gates });
		const result = handleTool("get_gate_config", TEST_DIR);
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.on_write.lint.command).toBe("biome check {file}");
	});

	it("rejects missing gates parameter", () => {
		const result = handleTool("save_gates", TEST_DIR, {});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Missing or invalid");
	});

	it("rejects array as gates parameter", () => {
		const result = handleTool("save_gates", TEST_DIR, { gates: [{ on_write: {} }] });
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Missing or invalid");
	});

	it("rejects invalid phase name", () => {
		const result = handleTool("save_gates", TEST_DIR, {
			gates: { on_invalid: { lint: { command: "biome" } } },
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("Invalid phase");
	});

	it("rejects non-object gateMap", () => {
		const result = handleTool("save_gates", TEST_DIR, {
			gates: { on_write: "not an object" },
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("must be an object");
	});

	it("rejects gate without command", () => {
		const result = handleTool("save_gates", TEST_DIR, {
			gates: { on_write: { lint: { timeout: 3000 } } },
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("must have a non-empty command");
	});

	it("rejects gate with empty command string", () => {
		const result = handleTool("save_gates", TEST_DIR, {
			gates: { on_write: { lint: { command: "  " } } },
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("must have a non-empty command");
	});

	it("rejects empty gates object", () => {
		const result = handleTool("save_gates", TEST_DIR, { gates: {} });
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("No gates provided");
	});

	it("atomically replaces existing gates", () => {
		const first = { on_write: { lint: { command: "eslint {file}" } } };
		const second = { on_commit: { test: { command: "vitest run" } } };
		handleTool("save_gates", TEST_DIR, { gates: first });
		handleTool("save_gates", TEST_DIR, { gates: second });
		const result = handleTool("get_gate_config", TEST_DIR);
		const parsed = JSON.parse(result.content[0]!.text);
		expect(parsed.on_write).toBeUndefined();
		expect(parsed.on_commit.test.command).toBe("vitest run");
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
