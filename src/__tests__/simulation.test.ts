import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPace, writePace } from "../state/pace.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import type { GatesConfig } from "../types.ts";

/**
 * End-to-end simulation of alfred hook flow.
 * Imports handlers directly and captures stdout/exit behavior.
 */

const TEST_DIR = join(import.meta.dirname, ".tmp-simulation");
const ALFRED_DIR = join(TEST_DIR, ".alfred");
const STATE_DIR = join(ALFRED_DIR, ".state");

let stdoutCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

function setupFailingLintGate(): void {
	const gates: GatesConfig = {
		on_write: {
			lint: { command: "echo 'Error: unused import' && exit 1", timeout: 3000 },
		},
	};
	writeFileSync(join(ALFRED_DIR, "gates.json"), JSON.stringify(gates));
}

function setupPassingGates(): void {
	const gates: GatesConfig = {
		on_write: {
			lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
		},
	};
	writeFileSync(join(ALFRED_DIR, "gates.json"), JSON.stringify(gates));
}

beforeEach(() => {
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stdoutCapture = [];
	exitCode = null;

	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
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

		// Now gate passes for file A
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

describe("Scenario 4: Git commit resets pace", () => {
	it("pace updated after commit", async () => {
		writePace({
			last_commit_at: new Date(Date.now() - 60 * 60_000).toISOString(),
			changed_files: 10,
			tool_calls: 100,
		});
		writeFileSync(join(ALFRED_DIR, "gates.json"), JSON.stringify({}));

		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "git commit -m 'test'" },
		});

		const pace = readPace();
		expect(pace).not.toBeNull();
		expect(pace!.changed_files).toBe(0);
		const elapsed = Date.now() - new Date(pace!.last_commit_at).getTime();
		expect(elapsed).toBeLessThan(5000);
	});
});

describe("Scenario 5: Pace red zone blocks edits", () => {
	it("35+ min without commit on 5+ files → DENY", async () => {
		setupPassingGates();
		writePace({
			last_commit_at: new Date(Date.now() - 40 * 60_000).toISOString(),
			changed_files: 8,
			tool_calls: 50,
		});

		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				hook_type: "PreToolUse",
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
			});
		} catch {
			// process.exit(2) throws
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		expect(response?.hookSpecificOutput).toHaveProperty("permissionDecision", "deny");
	});
});

// ============================================================
// Phase 2: Plan amplification scenarios
// ============================================================

describe("Scenario 6: Plan mode → template injected with review gates", () => {
	it("full plan mode flow", async () => {
		const userPrompt = (await import("../hooks/user-prompt.ts")).default;

		await userPrompt({
			hook_type: "UserPromptSubmit",
			permission_mode: "plan",
			prompt: "implement authentication",
		});

		const response = getResponse();
		expect(response).not.toBeNull();

		const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
		expect(context).toBeDefined();
		// Must contain task structure guidance
		expect(context).toContain("1 file");
		expect(context).toContain("15 lines");
		expect(context).toContain("Verify");
		// Must contain review gates
		expect(context).toContain("Design Review");
		expect(context).toContain("Phase Review");
		expect(context).toContain("Final Review");
		expect(context).toContain("/alfred:review");
	});
});

describe("Scenario 7: Normal mode large task → plan mode suggestion", () => {
	it("long prompt triggers plan suggestion", async () => {
		const userPrompt = (await import("../hooks/user-prompt.ts")).default;

		const longPrompt =
			"Implement a complete authentication system with JWT tokens, refresh tokens, " +
			"login and signup endpoints, middleware for protected routes, password hashing with bcrypt, " +
			"update the user model to include password fields, add rate limiting on auth endpoints, " +
			"create integration tests for all auth flows, update the API documentation";

		await userPrompt({
			hook_type: "UserPromptSubmit",
			prompt: longPrompt,
		});

		const response = getResponse();
		expect(response).not.toBeNull();

		const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
		expect(context).toBeDefined();
		expect(context!.toLowerCase()).toContain("plan");
	});

	it("short prompt does NOT trigger plan suggestion", async () => {
		const userPrompt = (await import("../hooks/user-prompt.ts")).default;

		await userPrompt({
			hook_type: "UserPromptSubmit",
			prompt: "fix the typo in README",
		});

		// Should have no output
		const output = stdoutCapture.join("");
		expect(output).toBe("");
	});
});

describe("Scenario 8: ExitPlanMode → plan without review gates is DENIED", () => {
	it("plan with review gates passes, plan without is denied", async () => {
		const permReq = (await import("../hooks/permission-request.ts")).default;

		// Create plan directory with a plan that HAS review gates
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });

		writeFileSync(
			join(planDir, "good-plan.md"),
			[
				"## Context",
				"Adding auth feature",
				"",
				"## Tasks",
				"### Task 1: Add auth middleware",
				"- File: src/middleware.ts",
				"- Verify: src/__tests__/middleware.test.ts:authMiddleware",
				"",
				"## Review Gates",
				"- [ ] Design Review: /alfred:review",
				"- [ ] Final Review: /alfred:review",
			].join("\n"),
		);

		// ExitPlanMode — should pass
		await permReq({
			hook_type: "PermissionRequest",
			tool: { name: "ExitPlanMode" },
		});
		expect(exitCode).toBeNull();

		// Now replace with a plan that has NO review gates
		writeFileSync(
			join(planDir, "good-plan.md"),
			["## Context", "Quick fix", "", "## Tasks", "### Task 1: Fix bug"].join("\n"),
		);

		stdoutCapture = [];
		exitCode = null;

		try {
			await permReq({
				hook_type: "PermissionRequest",
				tool: { name: "ExitPlanMode" },
			});
		} catch {
			// process.exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		const reason = (response?.hookSpecificOutput as Record<string, string>)
			?.permissionDecisionReason;
		expect(reason).toContain("Review");
	});
});

describe("Scenario 9: Full flow — plan mode → implement → gate → deny → fix", () => {
	it("end-to-end with plan and wall integration", async () => {
		setupFailingLintGate();
		const userPrompt = (await import("../hooks/user-prompt.ts")).default;
		const postTool = (await import("../hooks/post-tool.ts")).default;
		const preTool = (await import("../hooks/pre-tool.ts")).default;

		// Step 1: User enters plan mode → template injected
		await userPrompt({
			hook_type: "UserPromptSubmit",
			permission_mode: "plan",
			prompt: "add helper function",
		});
		const planResponse = getResponse();
		expect(planResponse).not.toBeNull();
		expect(
			(planResponse?.hookSpecificOutput as Record<string, string>)?.additionalContext,
		).toContain("Review Gates");

		// Step 2: Claude implements (edit) → lint fails → pending-fixes
		stdoutCapture = [];
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/helper.ts") },
		});
		const fixes = readPendingFixes();
		expect(fixes.length).toBeGreaterThan(0);

		// Step 3: Claude tries to edit another file → DENIED
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

		// Step 4: Claude fixes the original file → gate passes → unblocked
		setupPassingGates();
		stdoutCapture = [];
		exitCode = null;
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/helper.ts") },
		});
		expect(readPendingFixes()).toHaveLength(0);

		// Step 5: Now Claude can edit other files
		stdoutCapture = [];
		exitCode = null;
		await preTool({
			hook_type: "PreToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/other.ts") },
		});
		expect(exitCode).toBeNull(); // allowed
	});
});

// ============================================================
// Phase 3: Execution loop scenarios
// ============================================================

describe("Scenario 10: Stop hook blocks when pending fixes exist", () => {
	it("prevents Claude from stopping with unfixed errors", async () => {
		setupFailingLintGate();
		const postTool = (await import("../hooks/post-tool.ts")).default;
		const stop = (await import("../hooks/stop.ts")).default;

		// Create pending fixes
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});
		expect(readPendingFixes().length).toBeGreaterThan(0);

		// Stop hook should block
		stdoutCapture = [];
		exitCode = null;
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// process.exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		expect((response?.hookSpecificOutput as Record<string, string>)?.decision).toBe("block");
	});
});

describe("Scenario 11: Stop hook allows when clean", () => {
	it("Claude can stop normally when no pending fixes", async () => {
		const stop = (await import("../hooks/stop.ts")).default;

		await stop({ hook_type: "Stop" });

		expect(exitCode).toBeNull();
	});
});

describe("Scenario 12: PreCompact → SessionStart handoff", () => {
	it("state preserved across compaction", async () => {
		const preCompact = (await import("../hooks/pre-compact.ts")).default;
		const sessionStart = (await import("../hooks/session-start.ts")).default;
		const { readHandoff } = await import("../state/handoff.ts");

		// Create some pending fixes to capture in handoff
		const { writePendingFixes: wpf } = await import("../state/pending-fixes.ts");
		wpf([{ file: "src/broken.ts", errors: ["type error"], gate: "typecheck" }]);

		// PreCompact saves handoff
		await preCompact({ hook_type: "PreCompact" });
		const handoff = readHandoff();
		expect(handoff).not.toBeNull();
		expect(handoff!.pending_fixes).toBe(true);
		expect(handoff!.next_steps).toContain("broken.ts");

		// SessionStart restores handoff
		stdoutCapture = [];
		await sessionStart({ hook_type: "SessionStart" });
		const response = getResponse();
		expect(response).not.toBeNull();
		const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
		expect(context).toContain("pending");
		expect(context).toContain("Next steps");

		// Handoff should be consumed (cleared)
		expect(readHandoff()).toBeNull();
	});
});

describe("Scenario 13: Stop infinite loop prevention", () => {
	it("stop_hook_active prevents re-blocking", async () => {
		const { writePendingFixes: wpf } = await import("../state/pending-fixes.ts");
		wpf([{ file: "src/foo.ts", errors: ["err"], gate: "lint" }]);

		const stop = (await import("../hooks/stop.ts")).default;

		// First stop → blocks
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);

		// Second stop with stop_hook_active → does NOT block
		stdoutCapture = [];
		exitCode = null;
		await stop({ hook_type: "Stop", stop_hook_active: true });
		expect(exitCode).toBeNull();
	});
});

describe("Scenario 14: Pace tracking updates on each edit", () => {
	it("changed_files increments and resets on commit", async () => {
		setupPassingGates();
		const postTool = (await import("../hooks/post-tool.ts")).default;

		// 3 edits → pace should track
		for (const file of ["a.ts", "b.ts", "c.ts"]) {
			await postTool({
				hook_type: "PostToolUse",
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, `src/${file}`) },
			});
		}

		let pace = readPace();
		expect(pace).not.toBeNull();
		expect(pace!.changed_files).toBe(3);
		expect(pace!.tool_calls).toBe(3);

		// git commit → resets
		stdoutCapture = [];
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "git commit -m 'done'" },
		});

		pace = readPace();
		expect(pace!.changed_files).toBe(0);
		expect(pace!.tool_calls).toBe(0);
	});
});

// ============================================================
// Phase 4: Init + review skill integration scenarios
// ============================================================

describe("Scenario 15: Init creates complete setup", () => {
	it("init creates gates, and hooks work with the created gates", async () => {
		// Set up a project with biome + tsc
		writeFileSync(join(TEST_DIR, "biome.json"), "{}");
		writeFileSync(join(TEST_DIR, "tsconfig.json"), "{}");
		writeFileSync(
			join(TEST_DIR, "package.json"),
			JSON.stringify({ devDependencies: { vitest: "^3" } }),
		);

		// Run gate detection (simulating what init does)
		const { detectGates } = await import("../gates/detect.ts");
		const gates = detectGates(TEST_DIR);

		// Verify detected gates
		expect(gates.on_write?.lint?.command).toContain("biome");
		expect(gates.on_write?.typecheck?.command).toContain("tsc");
		expect(gates.on_commit?.test?.command).toContain("vitest");

		// Write gates.json manually (as init would)
		writeFileSync(join(ALFRED_DIR, "gates.json"), JSON.stringify(gates));

		// Now PostToolUse should be able to load and run these gates
		const { loadGates } = await import("../gates/load.ts");
		const loaded = loadGates();
		expect(loaded).not.toBeNull();
		expect(loaded!.on_write?.lint).toBeDefined();
	});
});

describe("Scenario 16: Plan status tracking — Stop blocks on incomplete plan", () => {
	it("blocks when plan has pending tasks, allows when all done", async () => {
		const stop = (await import("../hooks/stop.ts")).default;

		// Create plan with incomplete tasks
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add helper [done]",
				"- File: src/helper.ts",
				"",
				"### Task 2: Add tests [pending]",
				"- File: src/__tests__/helper.test.ts",
				"",
				"## Review Gates",
				"- [x] Design Review",
				"- [ ] Final Review",
			].join("\n"),
		);

		// Stop should block — Task 2 and Final Review are incomplete
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		const reason = (response?.hookSpecificOutput as Record<string, string>)?.reason;
		expect(reason).toContain("2 incomplete");
		expect(reason).toContain("Add tests");
		expect(reason).toContain("Final Review");

		// Now mark all as done
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

		stdoutCapture = [];
		exitCode = null;

		await stop({ hook_type: "Stop" });
		expect(exitCode).toBeNull(); // allowed
	});
});

describe("Scenario 17: Full E2E — plan → implement → status update → stop", () => {
	it("complete lifecycle with plan tracking", async () => {
		setupPassingGates();
		const userPrompt = (await import("../hooks/user-prompt.ts")).default;
		const stop = (await import("../hooks/stop.ts")).default;

		// Step 1: Plan mode → template injected with status instructions
		await userPrompt({
			hook_type: "UserPromptSubmit",
			permission_mode: "plan",
			prompt: "add logging",
		});
		const planResponse = getResponse();
		const template = (planResponse?.hookSpecificOutput as Record<string, string>)
			?.additionalContext;
		expect(template).toContain("[pending]");
		expect(template).toContain("Update each task's status");

		// Step 2: Claude creates plan with pending tasks
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "logging-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add logger [pending]",
				"### Task 2: Add tests [pending]",
				"## Review Gates",
				"- [ ] Final Review",
			].join("\n"),
		);

		// Step 3: Stop should block (3 incomplete items)
		stdoutCapture = [];
		exitCode = null;
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);

		// Step 4: Claude completes tasks and updates plan
		writeFileSync(
			join(planDir, "logging-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add logger [done]",
				"### Task 2: Add tests [done]",
				"## Review Gates",
				"- [x] Final Review",
			].join("\n"),
		);

		// Step 5: Stop should allow
		stdoutCapture = [];
		exitCode = null;
		await stop({ hook_type: "Stop" });
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// TaskCompleted integration scenarios
// ============================================================

describe("Scenario 18: TaskCompleted auto-syncs plan status", () => {
	it("completing a task updates plan and unblocks stop", async () => {
		const taskCompleted = (await import("../hooks/task-completed.ts")).default;
		const stop = (await import("../hooks/stop.ts")).default;

		// Create plan with 2 pending tasks
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "feature.md"),
			[
				"## Tasks",
				"### Task 1: Add logger [pending]",
				"- File: src/logger.ts",
				"",
				"### Task 2: Add tests [pending]",
				"- File: src/__tests__/logger.test.ts",
				"",
				"## Review Gates",
				"- [ ] Final Review",
			].join("\n"),
		);

		// Stop should block (3 incomplete)
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);

		// Claude completes Task 1 via TaskUpdate → TaskCompleted fires
		stdoutCapture = [];
		exitCode = null;
		await taskCompleted({
			hook_type: "TaskCompleted",
			task_id: "1",
			task_subject: "Add logger",
		});
		expect(exitCode).toBeNull();

		// Verify plan was updated
		const { readFileSync: rfs } = await import("node:fs");
		const plan = rfs(join(planDir, "feature.md"), "utf-8");
		expect(plan).toContain("Add logger [done]");
		expect(plan).toContain("Add tests [pending]");

		// Stop still blocks (Task 2 + Final Review pending)
		stdoutCapture = [];
		exitCode = null;
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);

		// Claude completes Task 2
		stdoutCapture = [];
		exitCode = null;
		await taskCompleted({
			hook_type: "TaskCompleted",
			task_id: "2",
			task_subject: "Add tests",
		});

		// Manually check Final Review
		const planContent = rfs(join(planDir, "feature.md"), "utf-8");
		writeFileSync(
			join(planDir, "feature.md"),
			planContent.replace("- [ ] Final Review", "- [x] Final Review"),
		);

		// Now stop should allow
		stdoutCapture = [];
		exitCode = null;
		await stop({ hook_type: "Stop" });
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// Hook completeness scenarios
// ============================================================

describe("Scenario 19: SubagentStart injects quality context", () => {
	it("subagents receive pending-fixes warning and quality rules", async () => {
		const { writePendingFixes: wpf } = await import("../state/pending-fixes.ts");
		wpf([{ file: "src/broken.ts", errors: ["type error"], gate: "typecheck" }]);

		const subagentStart = (await import("../hooks/subagent-start.ts")).default;
		await subagentStart({ hook_type: "SubagentStart" });

		const response = getResponse();
		const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
		expect(context).toBeDefined();
		expect(context).toContain("15 lines");
		expect(context).toContain("broken.ts");
		expect(context).toContain("pending");
	});
});

describe("Scenario 20: PostToolUseFailure tracks consecutive errors", () => {
	it("suggests /clear after 2 consecutive tool failures", async () => {
		const postToolFailure = (await import("../hooks/post-tool-failure.ts")).default;

		await postToolFailure({
			hook_type: "PostToolUseFailure",
			tool_name: "Bash",
			tool_output: "Error: ENOENT no such file",
		});

		stdoutCapture = [];
		await postToolFailure({
			hook_type: "PostToolUseFailure",
			tool_name: "Bash",
			tool_output: "Error: ENOENT no such file",
		});

		const response = getResponse();
		const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
		expect(context).toContain("/clear");
		expect(context).toContain("2 times");
	});
});

describe("Scenario 21: ConfigChange blocks user_settings modification", () => {
	it("prevents Claude from removing hooks", async () => {
		const configChange = (await import("../hooks/config-change.ts")).default;
		try {
			await configChange({
				hook_type: "ConfigChange",
				tool_input: { source: "user_settings" },
			});
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);
	});
});

describe("Scenario 22: SessionEnd saves handoff on any exit", () => {
	it("preserves state even on interrupt", async () => {
		const { writePendingFixes: wpf } = await import("../state/pending-fixes.ts");
		wpf([{ file: "src/wip.ts", errors: ["incomplete"], gate: "lint" }]);

		const sessionEnd = (await import("../hooks/session-end.ts")).default;
		await sessionEnd({ hook_type: "SessionEnd" });

		const { readHandoff } = await import("../state/handoff.ts");
		const handoff = readHandoff();
		expect(handoff).not.toBeNull();
		expect(handoff!.pending_fixes).toBe(true);
		expect(handoff!.next_steps).toContain("wip.ts");
	});
});
