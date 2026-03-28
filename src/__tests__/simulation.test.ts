import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../state/flush.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
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
}

function setupPassingGates(): void {
	const gates: GatesConfig = {
		on_write: {
			lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
		},
	};
	writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));
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

function getResponse(): Record<string, unknown> | null {
	const output = stdoutCapture.join("");
	if (!output) return null;
	return JSON.parse(output);
}

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
		const denyResponse = getResponse();
		expect(denyResponse?.hookSpecificOutput).toHaveProperty("permissionDecision", "deny");

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

describe("Scenario 9: Full flow — implement → gate → deny → fix", () => {
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

describe("Scenario 10: Stop hook blocks when pending fixes exist", () => {
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
		const response = getResponse();
		expect((response as Record<string, string>)?.decision).toBe("block");
	});
});

describe("Scenario 11: Stop hook allows when clean", () => {
	it("Claude can stop normally when no pending fixes and review completed", async () => {
		const { recordReview } = await import("../state/session-state.ts");
		recordReview();

		const stop = (await import("../hooks/stop.ts")).default;
		await stop({ hook_type: "Stop" });
		expect(exitCode).toBeNull();
	});
});

describe("Scenario 13: Stop infinite loop prevention", () => {
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

describe("Scenario 15: Init creates empty gates, session-start prompts detection", () => {
	it("session-start responds with detect-gates prompt when gates are empty", async () => {
		writeFileSync(join(QULT_DIR, "gates.json"), "{}");

		const sessionStart = (await import("../hooks/session-start.ts")).default;
		await sessionStart({ session_id: "test" });

		const output = stdoutCapture.join("");
		expect(output).toContain("qult:detect-gates");
	});
});

describe("Scenario 15b: Edit .qult/ files does not trigger gates", () => {
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

describe("Scenario 16: Plan status tracking — Stop blocks on incomplete plan", () => {
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

describe("Scenario 24: run_once_per_batch skips typecheck on 2nd edit", () => {
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

describe("Scenario 25: SubagentStop blocks incomplete reviewer output", () => {
	it("blocks reviewer without findings, allows with findings", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;

		try {
			await subagentStop({
				hook_type: "SubagentStop",
				agent_type: "qult-reviewer",
				last_assistant_message: "The code looks good overall.",
			});
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);

		stdoutCapture = [];
		exitCode = null;
		await subagentStop({
			hook_type: "SubagentStop",
			agent_type: "qult-reviewer",
			last_assistant_message: "- [medium] src/foo.ts:10 — unused variable\n  Fix: remove it",
		});
		expect(exitCode).toBeNull();

		stdoutCapture = [];
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

describe("Scenario 26: git commit DENIED without test pass", () => {
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

describe("Scenario 27: Stop blocks without review when plan exists", () => {
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
		const response = getResponse();
		expect((response as Record<string, string>)?.reason).toContain("review");
	});
});

// ============================================================
// Review small change skip
// ============================================================

describe("Scenario 31: Small change skips review requirement", () => {
	it("stop allows finish without review for small changes", async () => {
		const stop = (await import("../hooks/stop.ts")).default;
		await stop({ hook_type: "Stop" });
		expect(exitCode).toBeNull();
	});

	it("stop blocks finish without review for large changes (6+ gated files)", async () => {
		writeFileSync(
			join(QULT_DIR, "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
			}),
		);

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
		const response = getResponse();
		expect((response as Record<string, string>)?.decision).toBe("block");
	});
});

// ============================================================
// biome fix clears pending-fixes
// ============================================================

describe("Scenario 35: biome check --write clears stale pending-fixes", () => {
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

describe("Scenario: Review score threshold — PASS with high scores clears gate", () => {
	it("aggregate >= 12 allows", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await subagentStop({
			agent_type: "qult-reviewer",
			last_assistant_message:
				"Review: PASS\nScore: Correctness=5 Design=4 Security=4\nNo issues found",
		});
		expect(exitCode).toBeNull();
	});
});

describe("Scenario: Review score threshold — PASS with low scores blocks", () => {
	it("aggregate < 12 blocks for iteration", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		try {
			await subagentStop({
				agent_type: "qult-reviewer",
				last_assistant_message:
					"Review: PASS\nScore: Correctness=3 Design=3 Security=3\nNo issues found",
			});
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);
		const response = getResponse();
		expect((response as Record<string, string>)?.reason).toContain("below threshold");
	});
});

describe("Scenario: Review PASS without scores — fail-open", () => {
	it("PASS without score lines still clears gate (findings present)", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await subagentStop({
			agent_type: "qult-reviewer",
			last_assistant_message: "Review: PASS\n- [low] minor style issue\nNo issues found",
		});
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// Plan criteria in reviewer output
// ============================================================

describe("Scenario: Reviewer output with plan criteria findings passes SubagentStop", () => {
	it("plan criteria finding is treated as normal finding — PASS with high score clears", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		await subagentStop({
			agent_type: "qult-reviewer",
			last_assistant_message: [
				"Review: PASS",
				"Score: Correctness=4 Design=5 Security=5",
				'- [high] plan — Task 2 "Add tests" not verified: auth.test.ts:testLogin',
				"Fix: Add the missing test case",
			].join("\n"),
		});
		expect(exitCode).toBeNull();
		expect(stderrCapture.join("")).not.toContain("Reviewer output must include");
	});

	it("plan criteria finding with low correctness triggers FAIL verdict", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		try {
			await subagentStop({
				agent_type: "qult-reviewer",
				last_assistant_message: [
					"Review: FAIL",
					"Score: Correctness=2 Design=4 Security=4",
					'- [high] plan — Task 1 "Add auth" not verified: auth.test.ts:testLogin',
					"- [critical] src/auth.ts:15 — password stored in plaintext",
					"Fix: Use bcrypt hashing",
				].join("\n"),
			});
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);
	});
});

// ============================================================
// Doctor
// ============================================================

describe("Scenario 23: Init → Doctor reports all OK", () => {
	it("doctor passes after valid init-like setup", async () => {
		const gates = { on_write: { lint: { command: "echo ok", timeout: 3000 } } };
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));

		const originalHome = process.env.HOME;
		process.env.HOME = TEST_DIR;

		try {
			const claudeDir = join(TEST_DIR, ".claude");
			mkdirSync(join(claudeDir, "skills", "qult-review"), { recursive: true });
			mkdirSync(join(claudeDir, "skills", "qult-plan-generator"), {
				recursive: true,
			});
			mkdirSync(join(claudeDir, "agents"), { recursive: true });
			writeFileSync(join(claudeDir, "skills", "qult-review", "SKILL.md"), "# skill");
			writeFileSync(join(claudeDir, "skills", "qult-plan-generator", "SKILL.md"), "# skill");
			writeFileSync(join(claudeDir, "agents", "qult-reviewer.md"), "# agent");
			writeFileSync(join(claudeDir, "agents", "qult-plan-generator.md"), "# agent");
			mkdirSync(join(claudeDir, "rules"), { recursive: true });
			writeFileSync(join(claudeDir, "rules", "qult-quality.md"), "# rules");
			writeFileSync(join(claudeDir, "rules", "qult-plan.md"), "# rules");

			const { QULT_HOOKS } = await import("../init.ts");
			const hooks: Record<string, unknown> = {};
			for (const event of Object.keys(QULT_HOOKS)) {
				hooks[event] = QULT_HOOKS[event];
			}
			writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ hooks }));

			const { runChecks } = await import("../doctor.ts");
			const results = runChecks();

			const failures = results.filter((r) => r.status === "fail");
			expect(failures).toHaveLength(0);

			const hooksCheck = results.find((r) => r.name === "hooks");
			expect(hooksCheck!.status).toBe("ok");
			expect(hooksCheck!.message).toContain("5/5");
		} finally {
			process.env.HOME = originalHome;
		}
	});
});

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
