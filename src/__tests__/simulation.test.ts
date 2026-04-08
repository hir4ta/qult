import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatesCache, saveGates } from "../gates/load.ts";
import {
	closeDb,
	ensureSession,
	getDb,
	getProjectId,
	setProjectPath,
	setSessionScope,
	useTestDb,
} from "../state/db.ts";
import { flushAll, resetAllCaches } from "../state/flush.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import {
	readSessionState,
	recordReview,
	recordTestPass,
	resetCache as resetSessionCache,
} from "../state/session-state.ts";
import type { GatesConfig } from "../types.ts";

/**
 * End-to-end simulation of qult hook flow.
 * Imports handlers directly and captures stdout/exit behavior.
 */

const TEST_DIR = join(import.meta.dirname, ".tmp-simulation");

let stdoutCapture: string[] = [];
let stderrCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

function setupFailingLintGate(): void {
	const gates: GatesConfig = {
		on_write: {
			lint: { command: "echo 'Error: unused import' && exit 1", timeout: 3000 },
		},
	};
	saveGates(gates);
	resetGatesCache();
}

function setupPassingGates(): void {
	const gates: GatesConfig = {
		on_write: {
			lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
		},
	};
	saveGates(gates);
	resetGatesCache();
}

/** Write config key-value pairs to the project_configs table in DB. */
function setProjectConfig(config: Record<string, unknown>): void {
	const db = getDb();
	const projectId = getProjectId();
	const stmt = db.prepare(
		"INSERT OR REPLACE INTO project_configs (project_id, key, value) VALUES (?, ?, ?)",
	);
	function flatten(obj: Record<string, unknown>, prefix = ""): void {
		for (const [k, v] of Object.entries(obj)) {
			const key = prefix ? `${prefix}.${k}` : k;
			if (v !== null && typeof v === "object" && !Array.isArray(v)) {
				flatten(v as Record<string, unknown>, key);
			} else {
				stmt.run(projectId, key, JSON.stringify(v));
			}
		}
	}
	flatten(config);
}

beforeEach(() => {
	useTestDb();
	resetAllCaches();
	mkdirSync(TEST_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	// Create dummy source files for claim grounding
	mkdirSync(join(TEST_DIR, "src"), { recursive: true });
	for (const name of [
		"foo.ts",
		"a.ts",
		"b.ts",
		"c.ts",
		"d.ts",
		"e.ts",
		"f.ts",
		"g.ts",
		"h.ts",
		"api.ts",
		"types.ts",
		"bar.ts",
		"app.py",
		"auth.ts",
		"config.ts",
		"feature.ts",
		"file.ts",
		"handler.ts",
		"helper.ts",
		"other.ts",
		"real.ts",
		"strike.ts",
		"unrelated.ts",
		"unused.ts",
		"util.ts",
	]) {
		writeFileSync(join(TEST_DIR, "src", name), "// dummy");
	}
	process.chdir(TEST_DIR);
	setProjectPath(TEST_DIR);
	setSessionScope("test-session");
	ensureSession();
	stdoutCapture = [];
	stderrCapture = [];
	exitCode = null;

	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((data) => {
		stderrCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		exitCode = code as number;
		throw new Error(`process.exit(${code})`);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	closeDb();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

// No stdout output expected; deny/block write to stderr only

// ============================================================
// Core: Gate → DENY → Fix loop
// ============================================================

describe("Scenario 1: Edit → lint fails → block other files → allow fix file", () => {
	it("full flow", async () => {
		setupFailingLintGate();
		const postTool = (await import("../hooks/post-tool.ts")).default;
		const preTool = (await import("../hooks/pre-tool.ts")).default;

		// Step 1: PostToolUse — lint fails, pending-fixes written
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		const fixes = readPendingFixes();
		expect(fixes.length).toBeGreaterThan(0);
		expect(fixes[0]!.gate).toBe("lint");

		// Step 2: PreToolUse on DIFFERENT file — should DENY
		stdoutCapture = [];
		exitCode = null;
		try {
			await preTool({
				hook_type: "PreToolUse",
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/bar.ts") },
			});
		} catch {
			// process.exit(2) throws
		}

		expect(exitCode).toBe(2);
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("Fix existing errors");

		// Step 3: PreToolUse on SAME file — should ALLOW (no exit)
		stdoutCapture = [];
		exitCode = null;
		await preTool({
			hook_type: "PreToolUse",
			tool_name: "Edit",
			tool_input: { file_path: fixes[0]!.file },
		});

		expect(exitCode).toBeNull();
	});
});

describe("Scenario 2: Pending fixes preserved across files", () => {
	it("editing file B is DENIED when file A has errors (defense-in-depth)", async () => {
		setupFailingLintGate();
		const postTool = (await import("../hooks/post-tool.ts")).default;

		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/a.ts") },
		});
		expect(readPendingFixes()).toHaveLength(1);

		// Defense-in-depth: PostToolUse DENIES editing different file when pending-fixes exist
		stderrCapture = [];
		await expect(
			postTool({
				hook_type: "PostToolUse",
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/b.ts") },
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Fix existing errors");
	});
});

describe("Scenario 3: Fix clears only that file's errors", () => {
	it("fixing A clears A's error, editing same file allowed", async () => {
		setupFailingLintGate();
		const postTool = (await import("../hooks/post-tool.ts")).default;

		// Create error for file A
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/a.ts") },
		});
		expect(readPendingFixes()).toHaveLength(1);

		// Fix file A (editing the same file with pending-fixes is allowed)
		setupPassingGates();
		stdoutCapture = [];
		exitCode = null;
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/a.ts") },
		});

		expect(exitCode).toBeNull();
		expect(readPendingFixes()).toHaveLength(0);
	});
});

describe("Scenario 4: Git commit resets state", () => {
	it("state cleared after commit", async () => {
		saveGates({});

		const { recordTestPass, readSessionState } = await import("../state/session-state.ts");
		recordTestPass("vitest run");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "git commit -m 'test'" },
		});

		const state = readSessionState();
		expect(state.test_passed_at).toBeNull();
		expect(state.changed_file_paths).toHaveLength(0);
	});
});

// ============================================================
// Full flow: implement → gate → deny → fix
// ============================================================

describe("Scenario 5: Full flow — implement → gate → deny → fix", () => {
	it("end-to-end with wall integration", async () => {
		setupFailingLintGate();
		const postTool = (await import("../hooks/post-tool.ts")).default;
		const preTool = (await import("../hooks/pre-tool.ts")).default;

		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/helper.ts") },
		});
		const fixes = readPendingFixes();
		expect(fixes.length).toBeGreaterThan(0);

		stdoutCapture = [];
		exitCode = null;
		try {
			await preTool({
				hook_type: "PreToolUse",
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/other.ts") },
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);

		setupPassingGates();
		stdoutCapture = [];
		exitCode = null;
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/helper.ts") },
		});
		expect(readPendingFixes()).toHaveLength(0);

		stdoutCapture = [];
		exitCode = null;
		await preTool({
			hook_type: "PreToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/other.ts") },
		});
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// Stop hook
// ============================================================

describe("Scenario 6: Stop hook blocks when pending fixes exist", () => {
	it("prevents Claude from stopping with unfixed errors", async () => {
		setupFailingLintGate();
		const postTool = (await import("../hooks/post-tool.ts")).default;
		const stop = (await import("../hooks/stop.ts")).default;

		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});
		expect(readPendingFixes().length).toBeGreaterThan(0);

		stdoutCapture = [];
		exitCode = null;
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// process.exit(2)
		}

		expect(exitCode).toBe(2);
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("Pending lint/type errors");
	});
});

describe("Scenario 7: Stop hook allows when clean", () => {
	it("Claude can stop normally when no pending fixes and review completed", async () => {
		const { recordReview } = await import("../state/session-state.ts");
		recordReview();

		const stop = (await import("../hooks/stop.ts")).default;
		await stop({ hook_type: "Stop" });
		expect(exitCode).toBeNull();
	});
});

describe("Scenario 8: Stop infinite loop prevention", () => {
	it("stop_hook_active prevents re-blocking", async () => {
		const { writePendingFixes: wpf } = await import("../state/pending-fixes.ts");
		wpf([{ file: "src/foo.ts", errors: ["err"], gate: "lint" }]);

		const stop = (await import("../hooks/stop.ts")).default;

		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);

		stdoutCapture = [];
		exitCode = null;
		await stop({ hook_type: "Stop", stop_hook_active: true });
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// Session start + init
// ============================================================

describe("Scenario 9: lazyInit clears pending-fixes and produces no stdout", () => {
	it("lazyInit initializes DB state and produces no stdout", async () => {
		saveGates({});

		const { lazyInit, resetLazyInit } = await import("../hooks/lazy-init.ts");
		resetLazyInit();
		lazyInit();

		expect(stdoutCapture.join("")).toBe("");
		expect(readPendingFixes()).toHaveLength(0);
	});
});

// ============================================================
// Plan tracking
// ============================================================

describe("Scenario 11: Plan status tracking — Stop blocks on incomplete plan", () => {
	it("blocks when plan has pending tasks, allows when all done", async () => {
		const stop = (await import("../hooks/stop.ts")).default;
		const { recordChangedFile } = await import("../state/session-state.ts");

		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add helper [done]",
				"### Task 2: Add tests [pending]",
				"## Review Gates",
				"- [x] Design Review",
				"- [ ] Final Review",
			].join("\n"),
		);
		recordChangedFile("/fake/changed-file.ts");

		// Stop should block — incomplete tasks + no review
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);

		// Mark all as done + record review
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add helper [done]",
				"### Task 2: Add tests [done]",
				"## Review Gates",
				"- [x] Design Review",
				"- [x] Final Review",
			].join("\n"),
		);
		const { recordReview } = await import("../state/session-state.ts");
		recordReview();

		stdoutCapture = [];
		exitCode = null;
		await stop({ hook_type: "Stop" });
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// run_once_per_batch
// ============================================================

describe("Scenario 12: run_once_per_batch skips typecheck on re-edit, re-runs on new file", () => {
	it("typecheck skips on same-file re-edit, re-runs on new file, clears on commit", async () => {
		const gates: GatesConfig = {
			on_write: {
				lint: { command: "echo lint-ok", timeout: 3000 },
				typecheck: {
					command: "echo typecheck-ok",
					timeout: 3000,
					run_once_per_batch: true,
				},
			},
		};
		saveGates(gates);

		const { clearOnCommit, readSessionState, shouldSkipGate } = await import(
			"../state/session-state.ts"
		);
		clearOnCommit();

		const postTool = (await import("../hooks/post-tool.ts")).default;

		// First edit: typecheck runs
		await postTool({
			hook_type: "PostToolUse",
			session_id: "test-session",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/a.ts") },
		});
		expect(shouldSkipGate("typecheck", "test-session")).toBe(true);

		// Re-edit same file: typecheck skipped (same file, no invalidation)
		await postTool({
			hook_type: "PostToolUse",
			session_id: "test-session",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/a.ts") },
		});
		expect(shouldSkipGate("typecheck", "test-session")).toBe(true);

		// Edit new file: ran_gates invalidated, typecheck re-runs
		await postTool({
			hook_type: "PostToolUse",
			session_id: "test-session",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/b.ts") },
		});
		// After re-run, gate is marked as ran again
		expect(shouldSkipGate("typecheck", "test-session")).toBe(true);

		// Commit: clears ran_gates
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "git commit -m 'test'" },
		});
		const state3 = readSessionState();
		expect(state3.ran_gates.typecheck).toBeUndefined();
	});
});

// ============================================================
// SubagentStop
// ============================================================

describe("Scenario 13: SubagentStop blocks incomplete reviewer output", () => {
	it("blocks spec-reviewer without findings/verdict/score, allows with findings", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;

		try {
			await subagentStop({
				hook_type: "SubagentStop",
				agent_type: "qult-spec-reviewer",
				last_assistant_message: "The code looks good overall.",
			});
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);

		stderrCapture = [];
		exitCode = null;
		await subagentStop({
			hook_type: "SubagentStop",
			agent_type: "qult-spec-reviewer",
			last_assistant_message:
				"Spec: PASS\nScore: Completeness=4 Accuracy=4\n- [medium] minor — style\nFix: reformat",
		});
		expect(exitCode).toBeNull();

		stderrCapture = [];
		exitCode = null;
		await subagentStop({
			hook_type: "SubagentStop",
			agent_type: "Explore",
			last_assistant_message: "Found 3 files.",
		});
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// Commit gate: test + review required
// ============================================================

describe("Scenario 14: git commit DENIED without test pass", () => {
	it("blocks commit without test pass, allows after test + review", async () => {
		const gates: GatesConfig = {
			on_write: { lint: { command: "echo 'OK' && exit 0", timeout: 3000 } },
			on_commit: { test: { command: "echo 'OK' && exit 0", timeout: 3000 } },
		};
		saveGates(gates);

		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(join(planDir, "test-plan.md"), "## Tasks\n### Task 1: implement [done]\n");

		const { clearOnCommit, recordChangedFile, recordFinishStarted, recordTestPass, recordReview } =
			await import("../state/session-state.ts");
		clearOnCommit();
		recordFinishStarted(); // unlock finish gate (plan is active)
		for (let i = 0; i < 5; i++) recordChangedFile(`/fake/changed-file${i}.ts`);

		const preTool = (await import("../hooks/pre-tool.ts")).default;

		// Commit without test pass → DENY
		try {
			await preTool({
				hook_type: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'test'" },
			});
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);

		// Test pass but no review → DENY (many files changed)
		recordTestPass("vitest run");
		stdoutCapture = [];
		exitCode = null;
		try {
			await preTool({
				hook_type: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'test'" },
			});
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);

		// Test pass + review + finish → allow
		recordReview();
		recordFinishStarted();
		stdoutCapture = [];
		exitCode = null;
		await preTool({
			hook_type: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "git commit -m 'test'" },
		});
		expect(exitCode).toBeNull();
	});
});

describe("Scenario 15: Stop blocks without review when plan exists", () => {
	it("review required when plan is active", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			"## Tasks\n### Task 1: implement feature [done]\n",
		);

		const { recordChangedFile } = await import("../state/session-state.ts");
		recordChangedFile("/fake/changed-file.ts");

		const stop = (await import("../hooks/stop.ts")).default;
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("review");
	});
});

// ============================================================
// Review small change skip
// ============================================================

describe("Scenario 16: Small change skips review requirement", () => {
	it("stop allows finish without review for small changes", async () => {
		const stop = (await import("../hooks/stop.ts")).default;
		await stop({ hook_type: "Stop" });
		expect(exitCode).toBeNull();
	});

	it("stop blocks finish without review for large changes (6+ changed files)", async () => {
		const { recordChangedFile } = await import("../state/session-state.ts");
		for (let i = 0; i < 6; i++) {
			recordChangedFile(`/project/src/file${i}.ts`);
		}

		const stop = (await import("../hooks/stop.ts")).default;
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("review");
	});
});

// ============================================================
// biome fix clears pending-fixes
// ============================================================

describe("Scenario 17: biome check --write clears stale pending-fixes", () => {
	it("revalidation clears fixes when gate now passes", async () => {
		// First: create pending fixes with a failing gate
		setupFailingLintGate();
		const postTool = (await import("../hooks/post-tool.ts")).default;

		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});
		expect(readPendingFixes().length).toBeGreaterThan(0);

		// Now switch to passing gates and run a fix command
		setupPassingGates();
		stdoutCapture = [];
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "biome check --write src/" },
		});

		expect(readPendingFixes()).toHaveLength(0);
	});
});

// ============================================================
// Non-gated extension skip
// ============================================================

describe("Scenario: Non-gated file extensions are skipped", () => {
	it("biome gate skips .md files but runs on .ts files", async () => {
		saveGates({
			on_write: {
				lint: { command: "biome check {file} || exit 1", timeout: 3000 },
			},
		});

		const postTool = (await import("../hooks/post-tool.ts")).default;

		// .md file → skipped (no pending fixes)
		await postTool({
			tool_name: "Write",
			tool_input: { file_path: join(TEST_DIR, "docs/README.md") },
		});
		expect(readPendingFixes()).toHaveLength(0);
	});
});

// ============================================================
// Review score threshold
// ============================================================

describe("Scenario: 3-stage review score threshold — high scores clears gate", () => {
	it("aggregate >= threshold allows after all 3 stages", async () => {
		setProjectConfig({ review: { score_threshold: 24 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=5 Accuracy=4\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=4 Maintainability=4\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=4 Hardening=4\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-adversarial-reviewer",
			last_assistant_message:
				"Adversarial: PASS\nScore: EdgeCases=4 LogicCorrectness=4\nNo issues found.",
		});
		expect(exitCode).toBeNull();
	});
});

describe("Scenario: 3-stage review score threshold — low scores blocks", () => {
	it("aggregate < threshold blocks after all 4 stages", async () => {
		setProjectConfig({ review: { score_threshold: 32, dimension_floor: 1 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message:
				"Spec: PASS\nScore: Completeness=3 Accuracy=3\n- [low] src/a.ts — gap\n- [low] src/b.ts — gap",
		});
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message:
				"Quality: PASS\nScore: Design=3 Maintainability=3\n- [low] src/c.ts — issue\n- [low] src/d.ts — issue",
		});
		await subagentStop({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=3 Hardening=3\n- [low] src/e.ts — weak\n- [low] src/f.ts — weak",
		});
		try {
			await subagentStop({
				agent_type: "qult-adversarial-reviewer",
				last_assistant_message:
					"Adversarial: PASS\nScore: EdgeCases=3 LogicCorrectness=3\n- [low] src/g.ts — edge case\n- [low] src/h.ts — logic",
			});
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("below threshold");
	});
});

describe("Scenario: Spec FAIL blocks", () => {
	it("spec FAIL verdict blocks with FAIL message", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		try {
			await subagentStop({
				agent_type: "qult-spec-reviewer",
				last_assistant_message: [
					"Spec: FAIL",
					"Score: Completeness=2 Accuracy=4",
					'- [critical] plan — Task 1 "Add auth" not implemented',
					"Fix: implement the handler",
				].join("\n"),
			});
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("FAIL");
	});
});

// ============================================================
// Doctor
// ============================================================

// init/doctor are now skills, not CLI commands — no simulation scenario needed

// ============================================================
// on_review gate in gates.json
// ============================================================

describe("Scenario: gates.json with on_review section loads correctly", () => {
	it("on_review gates are loaded", async () => {
		const gates: GatesConfig = {
			on_write: { lint: { command: "echo ok", timeout: 3000 } },
			on_commit: { test: { command: "vitest run", timeout: 30000 } },
			on_review: { e2e: { command: "playwright test", timeout: 60000 } },
		};
		saveGates(gates);
		resetGatesCache();

		const { loadGates } = await import("../gates/load.ts");
		const loaded = loadGates();
		expect(loaded).not.toBeNull();
		expect(loaded!.on_review).toBeDefined();
		expect(loaded!.on_review!.e2e!.command).toBe("playwright test");
	});
});

// ============================================================
// Plan validation: Level 1 + Level 2 + Level 3 (plan-evaluator)
// ============================================================

describe("Scenario: Plan validation full flow", () => {
	it("L1 blocks plan missing ## Context (via SubagentStop)", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "incomplete-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add auth [pending]",
				"- **File**: src/auth.ts",
				"- **Change**: Add JWT auth middleware with token verification",
				"- **Boundary**: Do not modify route handlers",
				"- **Verify**: src/__tests__/auth.test.ts:testAuth",
				"",
				"## Success Criteria",
				"- [ ] `bun vitest run` -- pass",
			].join("\n"),
		);

		const handler = (await import("../hooks/subagent-stop/index.ts")).default;
		try {
			await handler({
				hook_type: "SubagentStop",
				agent_type: "Plan",
				last_assistant_message: "Plan created.",
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Context");
	});

	it("L2 blocks plan with vague Change field", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "vague-plan.md"),
			[
				"## Context",
				"Fixing auth issues.",
				"",
				"## Tasks",
				"### Task 1: Fix auth [pending]",
				"- **File**: src/auth.ts",
				"- **Change**: Fix the auth",
				"- **Boundary**: none",
				"- **Verify**: src/__tests__/auth.test.ts:testAuth",
				"",
				"## Success Criteria",
				"- [ ] `bun vitest run` -- pass",
			].join("\n"),
		);

		const handler = (await import("../hooks/subagent-stop/index.ts")).default;
		try {
			await handler({
				hook_type: "SubagentStop",
				agent_type: "Plan",
				last_assistant_message: "Plan created.",
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("vague");
	});

	it("L1+L2 pass for well-formed plan with evaluator done", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "good-plan.md"),
			[
				"## Context",
				"Adding JWT auth middleware for API routes.",
				"",
				"## Tasks",
				"### Task 1: Add auth middleware [pending]",
				"- **File**: src/auth.ts",
				"- **Change**: Create verifyJWT middleware that validates Bearer tokens using jose library",
				"- **Boundary**: Do not modify existing route handlers or auth config",
				"- **Verify**: src/__tests__/auth.test.ts:testVerifyJWT",
				"",
				"## Success Criteria",
				"- [ ] `bun vitest run` -- all tests pass",
			].join("\n"),
		);

		const { recordPlanEvalIteration } = await import("../state/session-state.ts");
		recordPlanEvalIteration(12);

		const handler = (await import("../hooks/subagent-stop/index.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "Plan",
			last_assistant_message: "Plan created.",
		});
		expect(exitCode).toBeNull();
	});

	it("plan-evaluator PASS with high score allows completion", async () => {
		const handler = (await import("../hooks/subagent-stop/index.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "qult-plan-evaluator",
			last_assistant_message:
				"Plan: PASS\nScore: Feasibility=5 Completeness=4 Clarity=5\n\nNo issues found.",
		});
		expect(exitCode).toBeNull();
	});

	it("plan-evaluator REVISE blocks completion", async () => {
		const handler = (await import("../hooks/subagent-stop/index.ts")).default;
		try {
			await handler({
				hook_type: "SubagentStop",
				agent_type: "qult-plan-evaluator",
				last_assistant_message:
					"Plan: REVISE\nScore: Feasibility=2 Completeness=3 Clarity=3\n\n- [critical] Task 1 — File references non-existent path\nFix: use correct path",
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);
	});
});

// ============================================================
// Adaptive block messages
// ============================================================

describe("Scenario: Adaptive 4-stage review block mentions weakest dimension", () => {
	it("first iteration block mentions weakest dimension across all stages", async () => {
		setProjectConfig({ review: { score_threshold: 32, dimension_floor: 1 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message:
				"Spec: PASS\nScore: Completeness=3 Accuracy=3\n- [low] src/a.ts — gap\n- [low] src/b.ts — gap",
		});
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message:
				"Quality: PASS\nScore: Design=2 Maintainability=3\n- [high] src/c.ts — design flaw\n- [low] src/d.ts — complexity",
		});
		await subagentStop({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=3 Hardening=3\n- [low] src/e.ts — weak\n- [low] src/f.ts — weak",
		});
		try {
			await subagentStop({
				agent_type: "qult-adversarial-reviewer",
				last_assistant_message:
					"Adversarial: PASS\nScore: EdgeCases=3 LogicCorrectness=3\n- [low] src/g.ts — edge case\n- [low] src/h.ts — logic",
			});
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);
		const errOutput = stderrCapture.join("");
		expect(errOutput).toContain("Design");
		expect(errOutput).toContain("2/5");
	});
});

// ============================================================
// TaskCompleted hook
// ============================================================

describe("Scenario: TaskCompleted verifies plan task", () => {
	it("responds with pass when verify test succeeds", async () => {
		// Set up plan with verify field
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Context",
				"Test feature.",
				"",
				"## Tasks",
				"### Task 1: Add helper [pending]",
				"- **File**: src/helper.ts",
				"- **Change**: Add utility function",
				"- **Boundary**: None",
				"- **Verify**: src/__tests__/helper.test.ts:testHelper",
				"",
				"## Success Criteria",
				"- [ ] `echo ok` -- pass",
			].join("\n"),
		);

		// Set up gates with test runner
		saveGates({
			on_write: { lint: { command: "echo ok", timeout: 3000 } },
			on_commit: { test: { command: "vitest run", timeout: 30000 } },
		});

		const handler = (await import("../hooks/task-completed.ts")).default;
		await handler({
			hook_event_name: "TaskCompleted",
			task_subject: "Add helper",
		});

		// No stdout output — result is read via MCP get_session_status
		expect(stdoutCapture.join("")).toBe("");
	});

	it("silently returns when no plan exists", async () => {
		saveGates({});

		const handler = (await import("../hooks/task-completed.ts")).default;
		await handler({
			hook_event_name: "TaskCompleted",
			task_subject: "Some task",
		});

		expect(exitCode).toBeNull();
		expect(stdoutCapture.join("")).toBe("");
	});

	it("silently returns when task has no verify field", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Config update [pending]",
				"- **File**: config.json",
				"- **Change**: Update value",
			].join("\n"),
		);

		const handler = (await import("../hooks/task-completed.ts")).default;
		await handler({
			hook_event_name: "TaskCompleted",
			task_subject: "Config update",
		});

		expect(exitCode).toBeNull();
		expect(stdoutCapture.join("")).toBe("");
	});
});

// ============================================================
// ExitPlanMode selfcheck gate
// ============================================================

// ============================================================
// Test pass → commit allowed (full lifecycle)
// ============================================================

describe("Scenario 18: test pass recorded → commit allowed", () => {
	function setupGatesWithTest(): void {
		const gates: GatesConfig = {
			on_write: {
				lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
			},
			on_commit: {
				test: { command: "vitest run", timeout: 30000 },
			},
		};
		saveGates(gates);
		resetGatesCache();
	}

	it("commit denied without test pass, allowed after test pass", async () => {
		setupGatesWithTest();
		const { recordChangedFile } = await import("../state/session-state.ts");
		recordChangedFile("/fake/src/file.ts");
		const postTool = (await import("../hooks/post-tool.ts")).default;
		const preTool = (await import("../hooks/pre-tool.ts")).default;

		// Step 1: git commit without test → DENIED
		try {
			await preTool({
				tool_name: "Bash",
				tool_input: { command: "git commit -m 'no tests'" },
			});
		} catch {
			/* exit(2) */
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("test");

		// Reset tracking
		exitCode = null;
		stderrCapture = [];

		// Step 2: run test command (detected by postTool)
		await postTool({
			tool_name: "Bash",
			tool_input: { command: "bun vitest run" },
			tool_response: { stdout: "Tests passed\nexit code 0" },
		});

		// Verify test pass was recorded
		const { readLastTestPass } = await import("../state/session-state.ts");
		const testPass = readLastTestPass();
		expect(testPass).not.toBeNull();
		expect(testPass!.command).toContain("vitest");

		// Step 3: git commit after test pass → allowed
		await preTool({
			tool_name: "Bash",
			tool_input: { command: "git commit -m 'tested'" },
		});
		expect(exitCode).toBeNull();
	});
});

describe("Scenario: ExitPlanMode selfcheck — blocks once, passes on retry", () => {
	it("first ExitPlanMode is denied, second passes", async () => {
		const preTool = (await import("../hooks/pre-tool.ts")).default;

		// 1st attempt: denied
		try {
			await preTool({ tool_name: "ExitPlanMode" });
		} catch {
			/* exit(2) */
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("omissions");

		// Reset exit tracking
		exitCode = null;
		stderrCapture = [];

		// 2nd attempt: passes (selfcheck already blocked)
		await preTool({ tool_name: "ExitPlanMode" });
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// Disabled gate scenarios
// ============================================================

describe("Scenario 8: Disabled gate skips execution — no pending-fixes created", () => {
	it("full flow", async () => {
		setupFailingLintGate();
		const postTool = (await import("../hooks/post-tool.ts")).default;
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		const { disableGate } = await import("../state/session-state.ts");

		// Disable lint gate
		disableGate("lint");

		// Edit a file — lint gate should NOT run
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		// No pending fixes should exist
		const fixes = readPendingFixes();
		expect(fixes.length).toBe(0);

		// Editing another file should work (no DENY)
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/bar.ts") },
		});
		expect(exitCode).toBeNull();
	});
});

describe("Scenario 9: Parallel gate execution collects results correctly", () => {
	it("full flow", async () => {
		// Setup 2 gates: one passes, one fails
		const gates: GatesConfig = {
			on_write: {
				lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
				typecheck: { command: "echo 'Type error in foo.ts' && exit 1", timeout: 3000 },
			},
		};
		saveGates(gates);
		resetGatesCache();

		const postTool = (await import("../hooks/post-tool.ts")).default;

		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		// Should have pending fixes from typecheck (not lint)
		const fixes = readPendingFixes();
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.gate).toBe("typecheck");
		expect(fixes[0]!.errors[0]).toContain("Type error");
	});
});

describe("Scenario 10: Parallel gate with timeout — timeout gate fails, other succeeds", () => {
	it("full flow", async () => {
		// Setup 2 gates: one times out, one passes
		const gates: GatesConfig = {
			on_write: {
				lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
				slow: { command: "sleep 10", timeout: 200 },
			},
		};
		saveGates(gates);
		resetGatesCache();

		const postTool = (await import("../hooks/post-tool.ts")).default;

		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		// Timed-out gate should create pending fix; lint should pass
		const fixes = readPendingFixes();
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.gate).toBe("slow");
	});
});

// ============================================================
// TDD enforcement
// ============================================================

describe("Scenario: TDD enforcement — test file must be edited before impl file", () => {
	it("full flow: DENY impl → edit test → allow impl", async () => {
		setupPassingGates();

		// Set up plan with File + Verify
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "tdd-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add utility [pending]",
				"- **File**: src/util.ts",
				"- **Change**: Add helper function",
				"- **Boundary**: Don't modify existing code",
				"- **Verify**: src/__tests__/util.test.ts:testUtil",
			].join("\n"),
		);

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		const postTool = (await import("../hooks/post-tool.ts")).default;

		// Step 1: Try to edit impl file — DENIED (test not written yet)
		try {
			await preTool({
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/util.ts") },
			});
		} catch {
			/* exit(2) */
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("TDD");

		// Reset captures
		exitCode = null;
		stderrCapture = [];

		// Step 2: Edit test file — allowed, recorded via PostToolUse
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/__tests__/util.test.ts") },
		});
		expect(exitCode).toBeNull();

		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/__tests__/util.test.ts") },
		});

		// Step 3: Now edit impl file — allowed (test file already edited)
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/util.ts") },
		});
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// Dimension floor + 3-stage aggregate
// ============================================================

describe("Scenario: Dimension floor blocks PASS with weak dimension", () => {
	it("blocks spec PASS when a dimension is below floor", async () => {
		setProjectConfig({ review: { dimension_floor: 3 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-spec-reviewer",
				last_assistant_message: "Spec: PASS\nScore: Completeness=2 Accuracy=5\nNo issues found.",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("below minimum");
	});
});

describe("Scenario: 4-stage aggregate score enforcement", () => {
	it("blocks when aggregate is below threshold after all 4 stages", async () => {
		setProjectConfig({ review: { score_threshold: 32, dimension_floor: 1 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;

		// Stage 1: Spec PASS (low scores, findings required for < 4)
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message:
				"Spec: PASS\nScore: Completeness=3 Accuracy=3\n- [low] src/a.ts — gap\n- [low] src/b.ts — gap",
		});
		expect(exitCode).toBeNull();

		// Stage 2: Quality PASS (low scores)
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message:
				"Quality: PASS\nScore: Design=3 Maintainability=3\n- [low] src/c.ts — issue\n- [low] src/d.ts — issue",
		});
		expect(exitCode).toBeNull();

		// Stage 3: Security PASS
		await subagentStop({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=3 Hardening=3\n- [low] src/e.ts — weak\n- [low] src/f.ts — weak",
		});
		expect(exitCode).toBeNull();

		// Stage 4: Adversarial PASS — aggregate = 24 < 32, should block
		await expect(
			subagentStop({
				agent_type: "qult-adversarial-reviewer",
				last_assistant_message:
					"Adversarial: PASS\nScore: EdgeCases=3 LogicCorrectness=3\n- [low] src/g.ts — edge case\n- [low] src/h.ts — logic",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("below threshold");
	});

	it("allows when aggregate meets threshold", async () => {
		setProjectConfig({ review: { score_threshold: 32, dimension_floor: 1 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;

		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=4 Accuracy=4\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=4 Maintainability=4\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=4 Hardening=4\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-adversarial-reviewer",
			last_assistant_message:
				"Adversarial: PASS\nScore: EdgeCases=4 LogicCorrectness=4\nNo issues found.",
		});
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// MCP record_review → commit gate
// ============================================================

describe("Scenario: MCP record_review allows commit", () => {
	it("commit passes after record_review sets review_completed_at", async () => {
		const gates: GatesConfig = {
			on_commit: { test: { command: "echo ok", timeout: 3000 } },
		};
		saveGates(gates);
		resetGatesCache();

		const { handleTool } = await import("../mcp-server.ts");
		const { recordChangedFile, recordFinishStarted, recordTestPass } = await import(
			"../state/session-state.ts"
		);

		// Simulate enough changed files to trigger review requirement
		for (let i = 0; i < 6; i++) recordChangedFile(`src/file${i}.ts`);
		recordTestPass("bun vitest run");

		// Create plan (required for 6+ changed files)
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(join(planDir, "test-plan.md"), "## Tasks\n### Task 1: test [done]\n");

		// Without record_review → commit blocked
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await expect(
			preTool({ tool_name: "Bash", tool_input: { command: "git commit -m test" } }),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("review");

		// Reset exit state
		exitCode = null;
		stderrCapture = [];

		// Record review via MCP
		handleTool("record_review", TEST_DIR, { aggregate_score: 26 });

		// Now commit should pass (reset caches first, then record finish)
		resetAllCaches();
		recordFinishStarted();
		await preTool({ tool_name: "Bash", tool_input: { command: "git commit -m test" } });
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// MCP record_test_pass → commit gate
// ============================================================

describe("Scenario: MCP record_test_pass allows commit", () => {
	it("commit passes after record_test_pass sets test_passed_at", async () => {
		const gates: GatesConfig = {
			on_commit: { test: { command: "echo ok", timeout: 3000 } },
		};
		saveGates(gates);
		resetGatesCache();

		const { recordChangedFile } = await import("../state/session-state.ts");
		recordChangedFile("/fake/src/file.ts");

		const { handleTool } = await import("../mcp-server.ts");

		// Without test pass → commit blocked
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await expect(
			preTool({ tool_name: "Bash", tool_input: { command: "git commit -m test" } }),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("test");

		// Reset
		exitCode = null;
		stderrCapture = [];

		// Record test pass via MCP
		handleTool("record_test_pass", TEST_DIR, { command: "bun vitest run" });

		// Now commit should pass (review not required: < 5 files)
		resetAllCaches();
		await preTool({ tool_name: "Bash", tool_input: { command: "git commit -m test" } });
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// 3-stage aggregate: max iterations → allow with warning
// ============================================================

describe("Scenario: 3-stage aggregate max iterations allows with warning", () => {
	it("allows review after max iterations despite low aggregate", async () => {
		setProjectConfig({ review: { score_threshold: 36, max_iterations: 2, dimension_floor: 1 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;

		const lowSpec =
			"Spec: PASS\nScore: Completeness=3 Accuracy=3\n- [low] src/a.ts — gap\n- [low] src/b.ts — gap";
		const lowQuality =
			"Quality: PASS\nScore: Design=3 Maintainability=3\n- [low] src/c.ts — issue\n- [low] src/d.ts — issue";
		const lowSecurity =
			"Security: PASS\nScore: Vulnerability=3 Hardening=3\n- [low] src/e.ts — weak\n- [low] src/f.ts — weak";
		const lowAdversarial =
			"Adversarial: PASS\nScore: EdgeCases=3 LogicCorrectness=3\n- [low] src/g.ts — edge case\n- [low] src/h.ts — logic";

		// Iteration 1: aggregate 24/40 < 36 → blocks (iterCount=1 < maxIter=2)
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: lowSpec,
		});
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: lowQuality,
		});
		await subagentStop({
			agent_type: "qult-security-reviewer",
			last_assistant_message: lowSecurity,
		});
		await expect(
			subagentStop({
				agent_type: "qult-adversarial-reviewer",
				last_assistant_message: lowAdversarial,
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("24/40");

		// Reset for iteration 2
		exitCode = null;
		stderrCapture = [];

		// Iteration 2: same score → iterCount=2 >= maxIter=2 → allows with warning
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: lowSpec,
		});
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: lowQuality,
		});
		await subagentStop({
			agent_type: "qult-security-reviewer",
			last_assistant_message: lowSecurity,
		});
		await subagentStop({
			agent_type: "qult-adversarial-reviewer",
			last_assistant_message: lowAdversarial,
		});
		expect(exitCode).toBeNull();
		expect(stderrCapture.join("")).toContain("Max review iterations");

		// review_completed_at should be set
		const { readSessionState } = await import("../state/session-state.ts");
		expect(readSessionState().review_completed_at).toBeTruthy();
	});
});

// ============================================================
// Stage PASS with no parseable scores → blocks
// ============================================================

describe("Scenario: Stage PASS without parseable scores blocks", () => {
	it("spec PASS without score line blocks for revalidation", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-spec-reviewer",
				last_assistant_message: "Spec: PASS\nAll looks good, no issues found.",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("no parseable scores");
	});
});

// ============================================================
// TDD RED verification (full lifecycle)
// ============================================================

describe("Scenario: tddRedSimulation", () => {
	it("blocks impl edit when verify test passes, allows when it fails", async () => {
		// Set up plan with verify field
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Context",
				"Test RED verification.",
				"",
				"## Tasks",
				"### Task 1: Add feature [pending]",
				"- **File**: src/feature.ts",
				"- **Change**: Add new feature",
				"- **Boundary**: None",
				"- **Verify**: src/__tests__/feature.test.ts:testFeature",
				"",
				"## Success Criteria",
				"- [ ] `echo ok` -- pass",
			].join("\n"),
		);

		saveGates({
			on_write: { lint: { command: "echo ok", timeout: 3000 } },
			on_commit: { test: { command: "vitest run", timeout: 30000 } },
		});

		const { recordChangedFile, recordTaskVerifyResult } = await import("../state/session-state.ts");
		const preTool = (await import("../hooks/pre-tool.ts")).default;

		// Step 1: Test file edited
		recordChangedFile(join(TEST_DIR, "src/__tests__/feature.test.ts"));

		// Step 2: Verify test passed (RED violation) → DENY impl edit
		recordTaskVerifyResult("Task 1", true);
		try {
			await preTool({
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/feature.ts") },
			});
		} catch {
			/* exit(2) */
		}
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("already passes");

		// Step 3: Fix test to fail (RED confirmed) → allow impl edit
		recordTaskVerifyResult("Task 1", false);
		stderrCapture = [];
		exitCode = null;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/feature.ts") },
		});
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// Evaluator score-findings consistency
// ============================================================

describe("Scenario: Evaluator blocks on critical findings with high scores", () => {
	it("blocks when critical finding contradicts 5/5 scores", async () => {
		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "qult-quality-reviewer",
				last_assistant_message:
					"Quality: PASS\nScore: Design=5 Maintainability=5\n[critical] src/handler.ts:42 — god object with 15 responsibilities",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("Reconcile findings with scores");
	});
});

// ============================================================
// Workflow enforcement: Stop blocks on missing Verify results
// ============================================================

describe("Scenario: Stop warns when Verify results not recorded (advisory)", () => {
	it("warns (advisory) when plan tasks done but Verify results missing", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add feature [done]",
				"- **File**: src/feature.ts",
				"- **Verify**: src/__tests__/feature.test.ts:testFeature",
				"### Task 2: Add helper [done]",
				"- **File**: src/helper.ts",
				"- **Verify**: src/__tests__/helper.test.ts:testHelper",
			].join("\n"),
		);

		const { recordChangedFile, recordReview } = await import("../state/session-state.ts");
		recordChangedFile("/fake/changed-file.ts");
		recordReview();

		const stop = (await import("../hooks/stop.ts")).default;
		await stop({ hook_type: "Stop" });

		// Advisory warning, not blocking (tasks not tracked via TaskCreate)
		expect(exitCode).toBeNull();
		expect(stderrCapture.join("")).toContain("Verify");
		expect(stderrCapture.join("")).toContain("TaskCreate");
	});
});

// ============================================================
// Workflow enforcement: Plan without evaluator blocks
// ============================================================

describe("Scenario: Plan without evaluator blocks", () => {
	it("blocks Plan agent when plan-evaluator never ran", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Context",
				"Adding feature.",
				"",
				"## Tasks",
				"### Task 1: Add feature [pending]",
				"- **File**: src/feature.ts",
				"- **Change**: Add new feature with proper error handling",
				"- **Boundary**: None",
				"- **Verify**: src/__tests__/feature.test.ts:testFeature",
				"",
				"## Success Criteria",
				"- [ ] `bun vitest run` -- all tests pass",
			].join("\n"),
		);

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await expect(
			subagentStop({
				agent_type: "Plan",
				last_assistant_message: "Plan created.",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("not been evaluated");
	});
});

// ============================================================
// Concurrent sessions: state isolation
// ============================================================

describe("Scenario: Concurrent session state isolation", () => {
	it("session A and session B write independently", () => {
		// Session A: record test pass
		setSessionScope("session-A");
		ensureSession();
		recordTestPass("vitest run");
		flushAll();

		// Session B: record review (separate scope)
		resetSessionCache();
		setSessionScope("session-B");
		ensureSession();
		recordReview();
		flushAll();

		// Verify session A: test passed, no review
		resetSessionCache();
		setSessionScope("session-A");
		const stateA = readSessionState();
		expect(stateA.test_passed_at).not.toBeNull();
		expect(stateA.review_completed_at).toBeNull();

		// Verify session B: no test, review done
		resetSessionCache();
		setSessionScope("session-B");
		const stateB = readSessionState();
		expect(stateB.test_passed_at).toBeNull();
		expect(stateB.review_completed_at).not.toBeNull();
	});

	it("findLatestSessionId returns most recent session", async () => {
		const { findLatestSessionId } = await import("../state/db.ts");
		const db = getDb();

		// Ensure beforeEach's test-session has the earliest timestamp
		db.prepare(
			"UPDATE sessions SET started_at = '2025-01-01T00:00:00.000Z' WHERE id = 'test-session'",
		).run();

		setSessionScope("session-A");
		ensureSession();
		db.prepare(
			"UPDATE sessions SET started_at = '2025-01-01T00:00:01.000Z' WHERE id = 'session-A'",
		).run();

		setSessionScope("session-B");
		ensureSession();
		db.prepare(
			"UPDATE sessions SET started_at = '2025-01-01T00:00:02.000Z' WHERE id = 'session-B'",
		).run();

		const latest = findLatestSessionId();
		expect(latest).toBe("session-B");
	});
});

// ============================================================
// Parallel gate execution: multiple gates don't corrupt state
// ============================================================

describe("Scenario: Parallel on_write gates (1 fail, 2 pass)", () => {
	it("produces exactly 1 pending fix from the failing gate", async () => {
		const gates: GatesConfig = {
			on_write: {
				lint: { command: "echo 'lint error' && exit 1", timeout: 3000 },
				typecheck: { command: "echo 'OK' && exit 0", timeout: 3000 },
				format: { command: "echo 'formatted' && exit 0", timeout: 3000 },
			},
		};
		saveGates(gates);
		resetGatesCache();

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/a.ts") },
		});

		const fixes = readPendingFixes();
		expect(fixes).toHaveLength(1);
		expect(fixes[0]!.gate).toBe("lint");
		expect(fixes[0]!.errors[0]).toContain("lint error");
	});
});

// ============================================================
// 3-Strike escalation: gate fails 3 times on same file
// ============================================================

describe("Scenario: 3-Strike gate failure escalation", () => {
	it("warns to stderr after 3 consecutive gate failures on same file", async () => {
		setupFailingLintGate();

		const postTool = (await import("../hooks/post-tool.ts")).default;
		const { resetGatesCache } = await import("../gates/load.ts");
		const filePath = join(TEST_DIR, "src/strike.ts");

		for (let i = 0; i < 3; i++) {
			resetGatesCache();
			await postTool({
				tool_name: "Edit",
				tool_input: { file_path: filePath },
			});
		}

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("3-Strike");
		expect(stderr).toContain("lint");
	});
});

// ============================================================
// TaskCreate promotion: warn on first edit of plan task file
// ============================================================

describe("Scenario: TaskCreate promotion on plan task file", () => {
	it("suggests TaskCreate when editing a plan task file for the first time", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			["## Tasks", "### Task 1: Add feature [pending]", "- **File**: src/feature.ts"].join("\n"),
		);

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/feature.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("Plan task detected");
		expect(stderr).toContain("TaskCreate");

		// Second edit of same file: simulate postTool to record changed_file_paths
		const postTool = (await import("../hooks/post-tool.ts")).default;
		setupPassingGates();
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/feature.ts") },
		});

		// Clear stderr and edit again — no warning on second edit
		stderrCapture = [];
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/feature.ts") },
		});

		const stderr2 = stderrCapture.join("");
		expect(stderr2).not.toContain("Plan task detected");
	});
});

// ============================================================
// Export breaking change detection
// ============================================================

describe("Scenario: Export breaking change detection", () => {
	it("detects removed export and includes in gate summary", async () => {
		const { execSync } = await import("node:child_process");

		// Setup git repo with initial file
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, "src/api.ts"),
			"export function hello() {}\nexport function goodbye() {}\n",
		);
		setupPassingGates();
		execSync(
			"git init && git config user.email test@test && git config user.name test && git add -A && git commit -m init",
			{
				cwd: TEST_DIR,
				stdio: "ignore",
			},
		);

		// Remove an export
		writeFileSync(join(TEST_DIR, "src/api.ts"), "export function hello() {}\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/api.ts") },
		});

		const fixes = readPendingFixes();
		const exportFixes = fixes.filter((f) => f.gate === "export-check");
		expect(exportFixes).toHaveLength(1);
		expect(exportFixes[0]!.errors[0]).toContain("goodbye");

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("export-check FAIL");
	});
});

describe("Scenario: Multi-language hallucinated import detection", () => {
	it("Python import creates pending-fix and blocks other files", async () => {
		setupPassingGates();
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src/app.py"), "import nonexistent_module\nx = 1\n");

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/app.py") },
		});

		const fixes = readPendingFixes();
		const importFixes = fixes.filter((f) => f.gate === "import-check");
		expect(importFixes).toHaveLength(1);
		expect(importFixes[0]!.errors[0]).toContain("nonexistent_module");

		// Now try editing a different file — should DENY
		exitCode = null;
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/other.ts") },
			});
		} catch {
			/* exit(2) */
		}
		expect(exitCode).toBe(2);
	});
});

describe("Scenario: Task drift detection warns on out-of-scope edits", () => {
	it("warns but does not DENY", async () => {
		setupPassingGates();
		// Create plan with specific task files
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: A [pending]",
				"- **File**: src/a.ts",
				"### Task 2: B [pending]",
				"- **File**: src/b.ts",
			].join("\n"),
		);

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/unrelated.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("Task drift");
		expect(exitCode).toBeNull(); // Advisory only — no DENY
	});
});

// ============================================================
// Security-check detector → pending-fixes → DENY
// ============================================================

describe("Scenario: Security-check detects hardcoded secret and blocks", () => {
	it("creates pending-fix with security-check gate and blocks other files", async () => {
		setupPassingGates();
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(join(TEST_DIR, "src/config.ts"), `const key = "AKIAIOSFODNN7EXAMPLE1";\n`);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/config.ts") },
		});

		const fixes = readPendingFixes();
		const secFixes = fixes.filter((f) => f.gate === "security-check");
		expect(secFixes).toHaveLength(1);
		expect(secFixes[0]!.errors[0]).toContain("AWS access key");

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("security-check FAIL");

		// Verify DENY on other file
		exitCode = null;
		stderrCapture = [];
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/other.ts") },
			});
		} catch {
			// process.exit(2) throws
		}
		expect(exitCode).toBe(2);
	});
});

// ============================================================
// Security escalation threshold blocks in Stop
// ============================================================

describe("Scenario: Security escalation blocks Stop after threshold", () => {
	it("stop blocks when security_warning_count >= 5", async () => {
		setupPassingGates();
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });

		// Set escalation threshold to 5 for this test
		setProjectConfig({ escalation: { security_threshold: 5 } });
		const { resetConfigCache } = await import("../config.ts");
		resetConfigCache();

		// Trigger 5 security warnings by directly incrementing the counter
		const { incrementEscalation, recordChangedFile } = await import("../state/session-state.ts");
		for (let i = 0; i < 5; i++) {
			incrementEscalation("security_warning_count");
			recordChangedFile(join(TEST_DIR, `src/secret${i}.ts`));
		}
		flushAll();

		// Verify escalation counter
		const state = readSessionState();
		expect(state.security_warning_count).toBeGreaterThanOrEqual(5);

		// Stop should block
		exitCode = null;
		stderrCapture = [];
		const stop = (await import("../hooks/stop.ts")).default;
		try {
			await stop({ hook_event_name: "Stop" });
		} catch {
			// process.exit(2) throws (may throw for pending-fixes first)
		}
		expect(exitCode).toBe(2);
	});
});

// ============================================================
// Dead import detection is advisory (no DENY)
// ============================================================

describe("Scenario: Dead import detection is advisory only", () => {
	it("warns to stderr but does not create pending-fixes", async () => {
		setupPassingGates();
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, "src/unused.ts"),
			`import { readFileSync, writeFileSync } from "node:fs";\n\nconst x = readFileSync("f", "utf-8");\n`,
		);

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/unused.ts") },
		});

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("Dead import");
		expect(stderr).toContain("writeFileSync");

		// Advisory: no pending-fixes for dead imports
		const fixes = readPendingFixes();
		const deadImportFixes = fixes.filter((f) => f.gate === "dead-import-check");
		expect(deadImportFixes).toHaveLength(0);

		// No DENY on other files from dead imports alone
		exitCode = null;
		if (fixes.length === 0) {
			const preTool = (await import("../hooks/pre-tool.ts")).default;
			await preTool({
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/other.ts") },
			});
			expect(exitCode).toBeNull();
		}
	});
});

// ============================================================
// Plan-required bypass prevention
// ============================================================

describe("Scenario: plan-required is advisory (not blocking)", () => {
	it("MCP record_review succeeds and PreToolUse shows advisory without plan", async () => {
		// Set up 6+ changed files in session state (no plan)
		const { recordChangedFile, recordTestPass } = await import("../state/session-state.ts");
		recordTestPass("vitest run");
		for (let i = 0; i < 6; i++) {
			recordChangedFile(`/project/src/file${i}.ts`);
		}
		flushAll();

		// MCP record_review should succeed (plan check removed)
		const { handleTool } = await import("../mcp-server.ts");
		const reviewResult = handleTool("record_review", TEST_DIR, { aggregate_score: 28 });
		expect(reviewResult.isError).toBeUndefined();
		expect(reviewResult.content[0]!.text).toContain("recorded");

		// PreToolUse should show advisory but not deny
		const { recordReview } = await import("../state/session-state.ts");
		recordReview();
		flushAll();

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		await preTool({
			tool_name: "Bash",
			tool_input: { command: 'git commit -m "bypass attempt"' },
		});
		expect(exitCode).toBeNull(); // advisory, not deny
		expect(stderrCapture.join("")).toContain("Advisory");
	});
});

// ============================================================
// Incomplete review detection: 3 stages without Adversarial
// ============================================================

describe("Scenario: Incomplete review (only 3 of 4 stages) blocks", () => {
	it("blocks when Spec/Quality/Security complete but Adversarial is missing", async () => {
		setProjectConfig({ review: { score_threshold: 30, dimension_floor: 1 } });
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;

		// Run only 3 stages (no Adversarial)
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=4 Accuracy=4\nNo issues found.",
		});
		expect(exitCode).toBeNull();

		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=4 Maintainability=4\nNo issues found.",
		});
		expect(exitCode).toBeNull();

		// This is the critical point: Security completes, but Adversarial is missing.
		// Should warn but not block (fail-open, waiting for Adversarial)
		await subagentStop({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=4 Hardening=4\nNo issues found.",
		});
		expect(exitCode).toBeNull();
		const stderr = stderrCapture.join("");
		expect(stderr).toContain("Review warning");
		expect(stderr).toContain("only 3/4 stages");
		expect(stderr).toContain("Adversarial");
	});
});

describe("Simulation: claim grounding blocks reviewer with nonexistent file", () => {
	it("blocks reviewer with ungrounded claims", async () => {
		mkdirSync(join(TEST_DIR, "src"), { recursive: true });
		// Only create one file — the reviewer references two, so one is ungrounded
		writeFileSync(join(TEST_DIR, "src", "real.ts"), "export function foo() {}");

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		const output = [
			"Spec: PASS",
			"Score: Completeness=4 Accuracy=4",
			"[low] src/ghost.ts:10 — missing error handling",
			"[low] src/phantom.ts:20 — no validation",
		].join("\n");

		await expect(
			subagentStop({
				agent_type: "qult-spec-reviewer",
				last_assistant_message: output,
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("ungrounded");
		expect(stderrCapture.join("")).toContain("src/ghost.ts");
	});
});

// ============================================================
// Cross-project plan contamination fix (plan-status.ts)
// ============================================================

describe("Scenario: Cross-project plan contamination — project-local plan takes priority", () => {
	it("uses project-local plan when present, ignoring home ~/.claude/plans/", async () => {
		// Write a project-local plan
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "project-plan.md"),
			["## Tasks", "### Task 1: Local task [done]", "- **File**: src/local.ts"].join("\n"),
		);

		// Simulate home plans being present by setting CLAUDE_PLANS_DIR to a different dir
		// (We cannot write to ~/.claude/plans in tests, but we can verify the project plan is found)
		const { getActivePlan } = await import("../state/plan-status.ts");
		const plan = getActivePlan();

		expect(plan).not.toBeNull();
		expect(plan!.path).toContain("project-plan.md");
		expect(plan!.tasks[0]!.name).toBe("Local task");
	});
});

// ============================================================
// Failing Verify test blocks Stop hook
// ============================================================

describe("Scenario: Stop blocks when plan task Verify test failed", () => {
	it("blocks with exit 2 when tracked verify result is false and source files changed", async () => {
		// Write a plan with a Verify field
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add feature [done]",
				"- **File**: src/foo.ts",
				"- **Verify**: src/__tests__/foo.test.ts:testFoo",
			].join("\n"),
		);

		// Record a source file change so hasSourceChanges is true
		const { recordChangedFile, recordReview, recordTaskVerifyResult } = await import(
			"../state/session-state.ts"
		);
		recordChangedFile(`${TEST_DIR}/src/foo.ts`);
		recordReview();
		recordTaskVerifyResult("Task 1", false); // failing verify
		flushAll();

		const stop = (await import("../hooks/stop.ts")).default;
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// process.exit(2) throws
		}

		expect(exitCode).toBe(2);
		const stderr = stderrCapture.join("");
		expect(stderr).toContain("failing Verify tests");
		expect(stderr).toContain("Task 1");
	});

	it("allows when tracked verify result is true and source files changed", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add feature [done]",
				"- **File**: src/foo.ts",
				"- **Verify**: src/__tests__/foo.test.ts:testFoo",
			].join("\n"),
		);

		const { recordChangedFile, recordReview, recordTaskVerifyResult } = await import(
			"../state/session-state.ts"
		);
		recordChangedFile(`${TEST_DIR}/src/foo.ts`);
		recordReview();
		recordTaskVerifyResult("Task 1", true); // passing verify
		flushAll();

		const stop = (await import("../hooks/stop.ts")).default;
		await stop({ hook_type: "Stop" });

		expect(exitCode).toBeNull();
	});
});

// ============================================================
// Semantic check detector
// ============================================================

describe("Semantic check: silent failure detection", () => {
	it("detects empty catch block", async () => {
		const file = join(TEST_DIR, "src/foo.ts");
		writeFileSync(file, `try {\n  doSomething();\n} catch (e) {\n}\n`);

		const { detectSemanticPatterns } = await import("../hooks/detectors/semantic-check.ts");
		const fixes = detectSemanticPatterns(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.gate).toBe("semantic-check");
		expect(fixes[0]!.errors[0]).toContain("Empty catch block");
	});

	it("allows catch with fail-open comment", async () => {
		const file = join(TEST_DIR, "src/foo.ts");
		writeFileSync(file, `try {\n  doSomething();\n} catch {\n  /* fail-open */\n}\n`);

		const { detectSemanticPatterns } = await import("../hooks/detectors/semantic-check.ts");
		const fixes = detectSemanticPatterns(file);
		expect(fixes.length).toBe(0);
	});

	it("detects bare .map() call", async () => {
		const file = join(TEST_DIR, "src/foo.ts");
		writeFileSync(file, `const items = [1, 2, 3];\nitems.map(x => x * 2);\n`);

		const { detectSemanticPatterns } = await import("../hooks/detectors/semantic-check.ts");
		const fixes = detectSemanticPatterns(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors[0]).toContain("Return value of pure method discarded");
	});

	it("detects assignment in condition", async () => {
		const file = join(TEST_DIR, "src/foo.ts");
		writeFileSync(file, `let x = 5;\nif (x = 10) {\n  console.log(x);\n}\n`);

		const { detectSemanticPatterns } = await import("../hooks/detectors/semantic-check.ts");
		const fixes = detectSemanticPatterns(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors[0]).toContain("Assignment (=) inside condition");
	});
});

// ============================================================
// Security check: expanded patterns
// ============================================================

describe("Security check: expanded patterns", () => {
	it("detects path traversal risk", async () => {
		const file = join(TEST_DIR, "src/foo.ts");
		writeFileSync(file, `const data = readFile(req.query.path);\n`);

		const { detectSecurityPatterns } = await import("../hooks/detectors/security-check.ts");
		const fixes = detectSecurityPatterns(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors[0]).toContain("path traversal");
	});

	it("detects prototype pollution", async () => {
		const file = join(TEST_DIR, "src/foo.ts");
		writeFileSync(file, `obj.__proto__["admin"] = true;\n`);

		const { detectSecurityPatterns } = await import("../hooks/detectors/security-check.ts");
		const fixes = detectSecurityPatterns(file);
		expect(fixes.length).toBe(1);
		expect(fixes[0]!.errors[0]).toContain("Prototype pollution");
	});

	it("emits CORS advisory", async () => {
		const file = join(TEST_DIR, "src/foo.ts");
		writeFileSync(file, `const headers = { "Access-Control-Allow-Origin": "*" };\n`);

		const { detectSecurityPatterns } = await import("../hooks/detectors/security-check.ts");
		detectSecurityPatterns(file);
		const advisories = stderrCapture.join("");
		expect(advisories).toContain("CORS wildcard");
	});
});

// ============================================================
// Test quality: enhanced smell detection
// ============================================================

describe("Test quality: enhanced smells", () => {
	it("detects happy-path-only tests", async () => {
		const file = join(TEST_DIR, "src/foo.test.ts");
		writeFileSync(
			file,
			[
				'import { expect, it } from "vitest";',
				'it("returns correct value", () => { expect(fn(1)).toBe(2); });',
				'it("handles normal input", () => { expect(fn(2)).toBe(4); });',
				'it("works with valid data", () => { expect(fn(3)).toBe(6); });',
			].join("\n"),
		);

		const { analyzeTestQuality } = await import("../hooks/detectors/test-quality-check.ts");
		const result = analyzeTestQuality(file);
		expect(result).not.toBeNull();
		const smellTypes = result!.smells.map((s) => s.type);
		expect(smellTypes).toContain("happy-path-only");
	});

	it("detects missing boundary values", async () => {
		const file = join(TEST_DIR, "src/foo.test.ts");
		writeFileSync(
			file,
			[
				'import { expect, it } from "vitest";',
				'it("test 1", () => { expect(fn(5)).toBe(10); });',
				'it("test 2", () => { expect(fn(10)).toBe(20); });',
				'it("test 3", () => { expect(fn(100)).toBe(200); });',
			].join("\n"),
		);

		const { analyzeTestQuality } = await import("../hooks/detectors/test-quality-check.ts");
		const result = analyzeTestQuality(file);
		expect(result).not.toBeNull();
		const smellTypes = result!.smells.map((s) => s.type);
		expect(smellTypes).toContain("missing-boundary");
	});
});

// ============================================================
// Plan: Success Criteria parsing
// ============================================================

describe("Plan: parseSuccessCriteria", () => {
	it("extracts criteria from plan content", async () => {
		const { parseSuccessCriteria } = await import("../state/plan-status.ts");
		const content = [
			"## Tasks",
			"### Task 1: Foo [done]",
			"",
			"## Success Criteria",
			"",
			"- `bun vitest run` — all tests pass",
			"- `bun tsc --noEmit` — no type errors",
			"- security-check: 8 → ~23 patterns",
			"",
			"## Notes",
			"some note",
		].join("\n");

		const criteria = parseSuccessCriteria(content);
		expect(criteria).toHaveLength(3);
		expect(criteria[0]).toContain("bun vitest run");
		expect(criteria[2]).toContain("security-check");
	});

	it("returns empty array when no Success Criteria section", async () => {
		const { parseSuccessCriteria } = await import("../state/plan-status.ts");
		const content = "## Tasks\n### Task 1: Foo [done]\n";
		const criteria = parseSuccessCriteria(content);
		expect(criteria).toHaveLength(0);
	});
});

// ============================================================
// Cross-validation: reviewer contradictions
// ============================================================

describe("Cross-validation: reviewer contradictions", () => {
	it("detects Adversarial 'no issues' with semantic warnings", async () => {
		const { incrementEscalation } = await import("../state/session-state.ts");
		for (let i = 0; i < 3; i++) incrementEscalation("semantic_warning_count");
		flushAll();

		const { crossValidate } = await import("../hooks/subagent-stop/cross-validation.ts");
		const result = crossValidate("No issues found.", "Adversarial");
		expect(result.contradictions.length).toBeGreaterThan(0);
		expect(result.contradictions[0]).toContain("semantic warnings");
	});

	it("detects inter-reviewer score contradictions", async () => {
		const { crossValidateReviewers } = await import("../hooks/subagent-stop/cross-validation.ts");
		const result = crossValidateReviewers({
			Spec: { completeness: 5, accuracy: 5 },
			Quality: { design: 2, maintainability: 3 },
		});
		expect(result.length).toBeGreaterThan(0);
		expect(result[0]).toContain("Completeness=5");
	});
});

// ============================================================
// Fix: TDD — backtick stripping in plan File field
// ============================================================

describe("Plan: File field backtick stripping", () => {
	it("strips backticks from File field", async () => {
		const { parsePlanTasks } = await import("../state/plan-status.ts");
		const content = [
			"## Tasks",
			"### Task 1: Foo [pending]",
			"- **File**: `src/hooks/detectors/security-check.ts`",
			"- **Verify**: `src/__tests__/foo.test.ts:testFoo`",
		].join("\n");
		const tasks = parsePlanTasks(content);
		expect(tasks[0]!.file).toBe("src/hooks/detectors/security-check.ts");
		expect(tasks[0]!.file).not.toContain("`");
	});
});

// ============================================================
// Fix: typecheck ran_gates invalidation on new file
// ============================================================

describe("ran_gates invalidation on new file edit", () => {
	it("invalidates when editing a new file not yet in changed_file_paths", async () => {
		const { markGateRan, recordChangedFile, shouldSkipGate } = await import(
			"../state/session-state.ts"
		);

		recordChangedFile(`${TEST_DIR}/src/foo.ts`);
		markGateRan("typecheck", "test-session");
		flushAll();

		// Same file → skip (already recorded)
		expect(shouldSkipGate("typecheck", "test-session", `${TEST_DIR}/src/foo.ts`)).toBe(true);

		// New file → should invalidate (not in changed_file_paths yet)
		expect(shouldSkipGate("typecheck", "test-session", `${TEST_DIR}/src/bar.ts`)).toBe(false);
	});
});

// ============================================================
// Fix: escalation counter deduplication
// ============================================================

describe("Escalation counter deduplication", () => {
	it("does not re-increment when file already has pending fix for same gate", async () => {
		setupFailingLintGate();
		const postTool = (await import("../hooks/post-tool.ts")).default;

		// First edit: creates pending fix and increments counter
		writeFileSync(join(TEST_DIR, "src/foo.ts"), "const x = 1;");
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		const state1 = readSessionState();
		const firstCount =
			state1.security_warning_count +
			state1.duplication_warning_count +
			state1.semantic_warning_count;

		// Re-edit same file: pending fix exists, should NOT re-increment
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});

		const state2 = readSessionState();
		const secondCount =
			state2.security_warning_count +
			state2.duplication_warning_count +
			state2.semantic_warning_count;

		// Counts should be same (no inflation from re-edit)
		expect(secondCount).toBe(firstCount);
	});
});

describe("Plan archive after finish", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
		process.chdir(TEST_DIR);
		useTestDb();
		setProjectPath(TEST_DIR);
		setSessionScope("sim-archive-test");
		ensureSession();
		resetAllCaches();
	});

	afterEach(() => {
		flushAll();
		closeDb();
		process.chdir(originalCwd);
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("plan file is archived after finish and not detected in next session", async () => {
		// Create a plan file
		const plansDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(plansDir, { recursive: true });
		const planPath = join(plansDir, "test-plan.md");
		writeFileSync(
			planPath,
			"## Context\nTest\n\n## Tasks\n### Task 1: Test [done]\n- **File**: src/test.ts\n- **Verify**: src/test.test.ts:test",
		);

		// Verify plan is detected
		const { getActivePlan, hasPlanFile, archivePlanFile } = await import("../state/plan-status.ts");
		expect(hasPlanFile()).toBe(true);
		const plan = getActivePlan();
		expect(plan).not.toBeNull();

		// Archive the plan (simulating /qult:finish cleanup)
		archivePlanFile(planPath);

		// Verify plan is no longer detected
		expect(existsSync(planPath)).toBe(false);
		expect(existsSync(join(plansDir, "archive", "test-plan.md"))).toBe(true);

		// hasPlanFile should still return true because archive/ contains .md files
		// but getActivePlan should return null because scanPlanDir uses non-recursive readdirSync
		// Note: hasPlanFile checks readdirSync which lists entries (including "archive" dir name)
		// but filters by .endsWith(".md") — "archive" doesn't end in .md, so it's excluded
		expect(hasPlanFile()).toBe(false);
	});
});
