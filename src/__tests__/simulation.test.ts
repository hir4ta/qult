import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGatesCache } from "../gates/load.ts";
import { resetAllCaches } from "../state/flush.ts";
import { readPendingFixes, setFixesSessionScope } from "../state/pending-fixes.ts";
import {
	flush as flushSessionState,
	readSessionState,
	recordReview,
	recordTestPass,
	resetCache as resetSessionCache,
	setStateSessionScope,
} from "../state/session-state.ts";
import type { GatesConfig } from "../types.ts";

/**
 * End-to-end simulation of qult hook flow.
 * Imports handlers directly and captures stdout/exit behavior.
 */

const TEST_DIR = join(import.meta.dirname, ".tmp-simulation");
const QULT_DIR = join(TEST_DIR, ".qult");
const STATE_DIR = join(QULT_DIR, ".state");

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
	writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));
	resetGatesCache();
}

function setupPassingGates(): void {
	const gates: GatesConfig = {
		on_write: {
			lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
		},
	};
	writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));
	resetGatesCache();
}

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
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
	it("editing file B keeps errors for file A", async () => {
		setupFailingLintGate();
		const postTool = (await import("../hooks/post-tool.ts")).default;

		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/a.ts") },
		});
		expect(readPendingFixes()).toHaveLength(1);

		stdoutCapture = [];
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/b.ts") },
		});

		const fixes = readPendingFixes();
		expect(fixes).toHaveLength(2);
		expect(fixes.map((f) => f.file)).toContain(join(TEST_DIR, "src/a.ts"));
		expect(fixes.map((f) => f.file)).toContain(join(TEST_DIR, "src/b.ts"));
	});
});

describe("Scenario 3: Fix clears only that file's errors", () => {
	it("fixing A preserves B's errors", async () => {
		setupFailingLintGate();
		const postTool = (await import("../hooks/post-tool.ts")).default;

		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/a.ts") },
		});
		stdoutCapture = [];
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/b.ts") },
		});
		expect(readPendingFixes()).toHaveLength(2);

		setupPassingGates();
		stdoutCapture = [];
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/a.ts") },
		});

		const fixes = readPendingFixes();
		expect(fixes).toHaveLength(1);
		expect(fixes[0]!.file).toContain("b.ts");
	});
});

describe("Scenario 4: Git commit resets state", () => {
	it("state cleared after commit", async () => {
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify({}));

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

describe("Scenario 9: lazyInit creates state dir and clears pending-fixes", () => {
	it("lazyInit initializes .qult/.state/ and produces no stdout", async () => {
		writeFileSync(join(QULT_DIR, "gates.json"), "{}");

		const { lazyInit, resetLazyInit } = await import("../hooks/lazy-init.ts");
		resetLazyInit();
		lazyInit();

		expect(stdoutCapture.join("")).toBe("");
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(TEST_DIR, ".qult", ".state"))).toBe(true);
	});
});

describe("Scenario 10: Edit .qult/ files does not trigger gates", () => {
	it("skips gate execution when editing .qult/gates.json", async () => {
		setupFailingLintGate();

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			tool_name: "Write",
			tool_input: { file_path: join(QULT_DIR, "gates.json") },
		});

		expect(readPendingFixes()).toHaveLength(0);
		expect(stdoutCapture.join("")).not.toContain("lint error");
	});
});

// ============================================================
// Plan tracking
// ============================================================

describe("Scenario 11: Plan status tracking — Stop blocks on incomplete plan", () => {
	it("blocks when plan has pending tasks, allows when all done", async () => {
		const stop = (await import("../hooks/stop.ts")).default;

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

describe("Scenario 12: run_once_per_batch skips typecheck on 2nd edit", () => {
	it("typecheck runs once, clears on commit", async () => {
		const gates = {
			on_write: {
				lint: { command: "echo lint-ok", timeout: 3000 },
				typecheck: {
					command: "echo typecheck-ok",
					timeout: 3000,
					run_once_per_batch: true,
				},
			},
		};
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));

		const { clearOnCommit, readSessionState } = await import("../state/session-state.ts");
		clearOnCommit();

		const postTool = (await import("../hooks/post-tool.ts")).default;

		await postTool({
			hook_type: "PostToolUse",
			session_id: "test-session",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/a.ts") },
		});

		const state1 = readSessionState();
		expect(state1.ran_gates.typecheck).toBeDefined();
		expect(state1.ran_gates.typecheck!.session_id).toBe("test-session");

		stdoutCapture = [];
		await postTool({
			hook_type: "PostToolUse",
			session_id: "test-session",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/b.ts") },
		});

		stdoutCapture = [];
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
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));

		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(join(planDir, "test-plan.md"), "## Tasks\n### Task 1: implement [done]\n");

		const { clearOnCommit, recordTestPass, recordReview } = await import(
			"../state/session-state.ts"
		);
		clearOnCommit();

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

		// Test pass but no review → DENY (plan active)
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

		// Test pass + review → allow
		recordReview();
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
		writeFileSync(
			join(QULT_DIR, "gates.json"),
			JSON.stringify({
				on_write: {
					lint: { command: "biome check {file} || exit 1", timeout: 3000 },
				},
			}),
		);

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
		writeFileSync(
			join(TEST_DIR, ".qult", "config.json"),
			JSON.stringify({ review: { score_threshold: 24 } }),
		);
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
		expect(exitCode).toBeNull();
	});
});

describe("Scenario: 3-stage review score threshold — low scores blocks", () => {
	it("aggregate < threshold blocks after security stage", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "config.json"),
			JSON.stringify({ review: { score_threshold: 24, dimension_floor: 1 } }),
		);
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=3 Accuracy=3\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=3 Maintainability=3\nNo issues found.",
		});
		try {
			await subagentStop({
				agent_type: "qult-security-reviewer",
				last_assistant_message:
					"Security: PASS\nScore: Vulnerability=3 Hardening=3\nNo issues found.",
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
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));

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

describe("Scenario: Adaptive 3-stage review block mentions weakest dimension", () => {
	it("first iteration block mentions weakest dimension across all stages", async () => {
		writeFileSync(
			join(TEST_DIR, ".qult", "config.json"),
			JSON.stringify({ review: { score_threshold: 24, dimension_floor: 1 } }),
		);
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=3 Accuracy=3\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=2 Maintainability=3\nNo issues found.",
		});
		try {
			await subagentStop({
				agent_type: "qult-security-reviewer",
				last_assistant_message:
					"Security: PASS\nScore: Vulnerability=3 Hardening=3\nNo issues found.",
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
		writeFileSync(
			join(QULT_DIR, "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "echo ok", timeout: 3000 } },
				on_commit: { test: { command: "vitest run", timeout: 30000 } },
			}),
		);

		const handler = (await import("../hooks/task-completed.ts")).default;
		await handler({
			hook_event_name: "TaskCompleted",
			task_subject: "Add helper",
		});

		// No stdout output — result is read via MCP get_session_status
		expect(stdoutCapture.join("")).toBe("");
	});

	it("silently returns when no plan exists", async () => {
		writeFileSync(join(QULT_DIR, "gates.json"), "{}");

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
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));
		resetGatesCache();
	}

	it("commit denied without test pass, allowed after test pass", async () => {
		setupGatesWithTest();
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
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));
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
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));
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
		writeFileSync(
			join(QULT_DIR, "config.json"),
			JSON.stringify({ review: { dimension_floor: 3 } }),
		);
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

describe("Scenario: 3-stage aggregate score enforcement", () => {
	it("blocks when aggregate is below threshold after all 3 stages", async () => {
		writeFileSync(
			join(QULT_DIR, "config.json"),
			JSON.stringify({ review: { score_threshold: 24, dimension_floor: 1 } }),
		);
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;

		// Stage 1: Spec PASS (low scores)
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=3 Accuracy=3\nNo issues found.",
		});
		expect(exitCode).toBeNull();

		// Stage 2: Quality PASS (low scores)
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=3 Maintainability=3\nNo issues found.",
		});
		expect(exitCode).toBeNull();

		// Stage 3: Security PASS — aggregate = 18 < 24, should block
		await expect(
			subagentStop({
				agent_type: "qult-security-reviewer",
				last_assistant_message:
					"Security: PASS\nScore: Vulnerability=3 Hardening=3\nNo issues found.",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("below threshold");
	});

	it("allows when aggregate meets threshold", async () => {
		writeFileSync(
			join(QULT_DIR, "config.json"),
			JSON.stringify({ review: { score_threshold: 24, dimension_floor: 1 } }),
		);
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
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));
		resetGatesCache();

		const { handleTool } = await import("../mcp-server.ts");
		const { recordChangedFile, recordTestPass } = await import("../state/session-state.ts");

		// Simulate enough changed files to trigger review requirement
		for (let i = 0; i < 6; i++) recordChangedFile(`src/file${i}.ts`);
		recordTestPass("bun vitest run");

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

		// Now commit should pass
		resetAllCaches();
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
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));
		resetGatesCache();

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
		writeFileSync(
			join(QULT_DIR, "config.json"),
			JSON.stringify({ review: { score_threshold: 28, max_iterations: 2, dimension_floor: 1 } }),
		);
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop/index.ts")).default;

		// Iteration 1: aggregate 18/30 < 28 → blocks (iterCount=1 < maxIter=2)
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=3 Accuracy=3\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=3 Maintainability=3\nNo issues found.",
		});
		await expect(
			subagentStop({
				agent_type: "qult-security-reviewer",
				last_assistant_message:
					"Security: PASS\nScore: Vulnerability=3 Hardening=3\nNo issues found.",
			}),
		).rejects.toThrow("process.exit");
		expect(exitCode).toBe(2);
		expect(stderrCapture.join("")).toContain("18/30");

		// Reset for iteration 2
		exitCode = null;
		stderrCapture = [];

		// Iteration 2: same score → iterCount=2 >= maxIter=2 → allows with warning
		await subagentStop({
			agent_type: "qult-spec-reviewer",
			last_assistant_message: "Spec: PASS\nScore: Completeness=3 Accuracy=3\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-quality-reviewer",
			last_assistant_message: "Quality: PASS\nScore: Design=3 Maintainability=3\nNo issues found.",
		});
		await subagentStop({
			agent_type: "qult-security-reviewer",
			last_assistant_message:
				"Security: PASS\nScore: Vulnerability=3 Hardening=3\nNo issues found.",
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

		writeFileSync(
			join(QULT_DIR, "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "echo ok", timeout: 3000 } },
				on_commit: { test: { command: "vitest run", timeout: 30000 } },
			}),
		);

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

describe("Scenario: Stop blocks when Verify results not recorded", () => {
	it("blocks when plan tasks done but Verify results missing", async () => {
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

		const { recordReview } = await import("../state/session-state.ts");
		recordReview();

		const stop = (await import("../hooks/stop.ts")).default;
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			/* exit(2) */
		}
		expect(exitCode).toBe(2);
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
		setStateSessionScope("session-A");
		setFixesSessionScope("session-A");
		recordTestPass("vitest run");
		flushSessionState();

		// Session B: record review (separate scope)
		resetSessionCache();
		setStateSessionScope("session-B");
		setFixesSessionScope("session-B");
		recordReview();
		flushSessionState();

		// Verify session A: test passed, no review
		resetSessionCache();
		setStateSessionScope("session-A");
		const stateA = readSessionState();
		expect(stateA.test_passed_at).not.toBeNull();
		expect(stateA.review_completed_at).toBeNull();

		// Verify session B: no test, review done
		resetSessionCache();
		setStateSessionScope("session-B");
		const stateB = readSessionState();
		expect(stateB.test_passed_at).toBeNull();
		expect(stateB.review_completed_at).not.toBeNull();
	});

	it("latest-session.json reflects last writer", async () => {
		const { atomicWriteJson } = await import("../state/atomic-write.ts");
		const markerPath = join(STATE_DIR, "latest-session.json");

		// Session A writes marker
		atomicWriteJson(markerPath, { session_id: "session-A", updated_at: new Date().toISOString() });
		let marker = JSON.parse(readFileSync(markerPath, "utf-8"));
		expect(marker.session_id).toBe("session-A");

		// Session B overwrites marker
		atomicWriteJson(markerPath, { session_id: "session-B", updated_at: new Date().toISOString() });
		marker = JSON.parse(readFileSync(markerPath, "utf-8"));
		expect(marker.session_id).toBe("session-B");
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
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));
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
		execSync("git init && git add -A && git commit -m init", {
			cwd: TEST_DIR,
			stdio: "ignore",
		});

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
