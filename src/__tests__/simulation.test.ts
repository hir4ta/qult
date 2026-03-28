import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAll, resetAllCaches } from "../state/flush.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import { readPace, writePace } from "../state/session-state.ts";
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
	mkdirSync(join(QULT_DIR, "metrics"), { recursive: true });
	mkdirSync(join(QULT_DIR, "gate-history"), { recursive: true });
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
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify({}));

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
	it("120+ min without commit on 15+ files → DENY", async () => {
		setupPassingGates();
		writePace({
			last_commit_at: new Date(Date.now() - 125 * 60_000).toISOString(),
			changed_files: 16,
			tool_calls: 80,
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
			prompt:
				"implement authentication with JWT tokens, add login and signup endpoints, middleware for protected routes, " +
				"password hashing with bcrypt, update user model with password fields, add rate limiting on auth endpoints, " +
				"create integration tests for all auth flows, update API documentation with auth examples, " +
				"add refresh token rotation logic, implement CORS configuration for frontend origin, " +
				"set up email verification flow with confirmation links and expiry tokens, " +
				"add two-factor authentication via TOTP with QR code generation",
		});

		const response = getResponse();
		expect(response).not.toBeNull();

		const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
		expect(context).toBeDefined();
		// Must contain task structure guidance
		expect(context).toContain("focused");
		expect(context).toContain("Verify");
		// Must contain success criteria
		expect(context).toContain("Success Criteria");
		// Full template: automatic review enforcement note
		expect(context).toContain("enforced by the harness");
		expect(context).toContain("/qult:review");
	});
});

describe("Scenario 7: Normal mode large task → no advisory (Opus 4.6)", () => {
	it("long prompt in normal mode produces no output", async () => {
		const userPrompt = (await import("../hooks/user-prompt.ts")).default;

		const longPrompt =
			"Implement a complete authentication system with JWT tokens, refresh tokens, " +
			"login and signup endpoints, middleware for protected routes, password hashing with bcrypt, " +
			"update the user model to include password fields, add rate limiting on auth endpoints, " +
			"create integration tests for all auth flows, update the API documentation, " +
			"implement CORS configuration, add email verification with confirmation links, " +
			"set up two-factor authentication support, add password reset with secure tokens, " +
			"implement session management with Redis-backed token storage and sliding expiry, " +
			"add OAuth2 provider integration for Google and GitHub SSO, implement account lockout " +
			"after 5 failed attempts with progressive backoff delays, create admin dashboard " +
			"for user management with role-based access control and audit logging";

		await userPrompt({
			hook_type: "UserPromptSubmit",
			prompt: longPrompt,
		});

		expect(exitCode).toBeNull();
		const output = stdoutCapture.join("");
		expect(output).toBe("");
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

describe("Scenario 8: ExitPlanMode → small plan passes, vague Verify in large plan is DENIED", () => {
	it("small plan passes without File field; large plan with vague Verify is denied", async () => {
		const permReq = (await import("../hooks/permission-request.ts")).default;

		// Create plan directory with a small plan (no File field — should pass)
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });

		writeFileSync(
			join(planDir, "small-plan.md"),
			["## Context", "Quick fix", "", "## Tasks", "### Task 1: Fix bug"].join("\n"),
		);

		// ExitPlanMode — small plan should pass
		await permReq({
			hook_type: "PermissionRequest",
			tool: { name: "ExitPlanMode" },
		});
		expect(exitCode).toBeNull();

		// Now replace with a large plan that has vague Verify fields
		writeFileSync(
			join(planDir, "small-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add feature",
				"- Verify: check it works",
				"### Task 2: Add tests",
				"- Verify: run tests",
				"### Task 3: Update docs",
				"- Verify: looks good",
				"### Task 4: Final cleanup",
				"- Verify: all done",
				"",
				"## Success Criteria",
				"- [ ] `bun vitest run` all tests pass",
			].join("\n"),
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
		expect(reason).toContain("Verify");
	});
});

describe("Scenario 9: ExitPlanMode → Success Criteria validation (large plan)", () => {
	it("large plan without Success Criteria is DENIED", async () => {
		const permReq = (await import("../hooks/permission-request.ts")).default;
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });

		writeFileSync(
			join(planDir, "no-criteria.md"),
			[
				"## Tasks",
				"### Task 1: Add feature",
				"- File: src/feature.ts",
				"- Verify: src/__tests__/feature.test.ts:testFeature",
				"### Task 2: Add model",
				"- File: src/model.ts",
				"- Verify: src/__tests__/model.test.ts:testModel",
				"### Task 3: Add service",
				"- File: src/service.ts",
				"- Verify: src/__tests__/service.test.ts:testService",
				"### Task 4: Add controller",
				"- File: src/controller.ts",
				"- Verify: src/__tests__/controller.test.ts:testController",
				"## Review Gates",
				"- [ ] Final Review",
			].join("\n"),
		);

		try {
			await permReq({ hook_type: "PermissionRequest", tool: { name: "ExitPlanMode" } });
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		const reason = (response?.hookSpecificOutput as Record<string, string>)
			?.permissionDecisionReason;
		expect(reason).toContain("Success Criteria");
	});
});

describe("Scenario 10: ExitPlanMode → concrete Success Criteria passes", () => {
	it("plan with concrete Success Criteria is allowed", async () => {
		const permReq = (await import("../hooks/permission-request.ts")).default;
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });

		writeFileSync(
			join(planDir, "good-criteria.md"),
			[
				"## Tasks",
				"### Task 1: Add feature",
				"- File: src/feature.ts",
				"- Verify: src/__tests__/feature.test.ts:testFeature",
				"## Success Criteria",
				"- [ ] `bun vitest run` all tests pass",
				"- [ ] `bun tsc --noEmit` no type errors",
				"## Review Gates",
				"- [ ] Final Review",
			].join("\n"),
		);

		await permReq({ hook_type: "PermissionRequest", tool: { name: "ExitPlanMode" } });
		expect(exitCode).toBeNull();
	});
});

describe("Scenario 9: Full flow — plan mode → implement → gate → deny → fix", () => {
	it("end-to-end with plan and wall integration", async () => {
		setupFailingLintGate();
		const userPrompt = (await import("../hooks/user-prompt.ts")).default;
		const postTool = (await import("../hooks/post-tool.ts")).default;
		const preTool = (await import("../hooks/pre-tool.ts")).default;

		// Step 1: User enters plan mode → template injected (500+ chars for full template)
		await userPrompt({
			hook_type: "UserPromptSubmit",
			permission_mode: "plan",
			prompt:
				"add helper function for parsing dates, validating format, handling timezones, converting between formats, " +
				"with comprehensive tests for edge cases including invalid inputs, null values, boundary dates across " +
				"multiple calendar systems, leap year handling, DST transitions, ISO 8601 compliance with offset parsing " +
				"and duration calculation support, also add formatting utilities for relative timestamps and localized " +
				"date output across common locales including Japanese era-based calendar formatting and Buddhist year systems",
		});
		const planResponse = getResponse();
		expect(planResponse).not.toBeNull();
		expect(
			(planResponse?.hookSpecificOutput as Record<string, string>)?.additionalContext,
		).toContain("enforced by the harness");

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

describe("Scenario 31: Small change skips review requirement", () => {
	it("stop allows finish without review for small changes (no plan, few files)", async () => {
		// Small change: 2 files changed, no plan
		writePace({
			last_commit_at: new Date().toISOString(),
			changed_files: 2,
			tool_calls: 5,
		});

		const stop = (await import("../hooks/stop.ts")).default;
		await stop({ hook_type: "Stop" });

		// Should NOT block — small change, review optional
		expect(exitCode).toBeNull();

		// Should emit stderr advisory
		const stderr = stderrCapture.join("");
		expect(stderr).toContain("review");
	});

	it("stop blocks finish without review for large changes (6+ gated files)", async () => {
		// Set up gates so gated extensions are known
		writeFileSync(
			join(QULT_DIR, "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
			}),
		);

		// Record 6 gated files (.ts)
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

	it("stop allows finish without review when only non-gated files changed", async () => {
		// Set up gates (covers .ts, not .md)
		writeFileSync(
			join(QULT_DIR, "gates.json"),
			JSON.stringify({
				on_write: { lint: { command: "biome check {file}", timeout: 3000 } },
			}),
		);

		// Record 10 .md files (not gated)
		const { recordChangedFile } = await import("../state/session-state.ts");
		for (let i = 0; i < 10; i++) {
			recordChangedFile(`/project/docs/file${i}.md`);
		}

		const stop = (await import("../hooks/stop.ts")).default;
		await stop({ hook_type: "Stop" });

		// Should NOT block — only non-gated files changed
		expect(exitCode).toBeNull();
	});

	it("stop blocks finish without review when plan is active", async () => {
		// Create a plan
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			"## Tasks\n### Task 1: implement feature [pending]\n",
		);

		const stop = (await import("../hooks/stop.ts")).default;
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			/* exit(2) */
		}

		expect(exitCode).toBe(2);
	});
});

describe("Scenario 12: PreCompact → PostCompact pending-fixes reminder", () => {
	it("pending fixes reminded across compaction", async () => {
		const preCompact = (await import("../hooks/pre-compact.ts")).default;
		const postCompact = (await import("../hooks/post-compact.ts")).default;

		const { writePendingFixes: wpf } = await import("../state/pending-fixes.ts");
		wpf([{ file: "src/broken.ts", errors: ["type error"], gate: "typecheck" }]);

		// PreCompact writes reminder to stderr
		await preCompact({ hook_type: "PreCompact" });
		const preStderr = stderrCapture.join("");
		expect(preStderr).toContain("pending fix");
		expect(preStderr).toContain("src/broken.ts");

		// PostCompact also reminds via stderr
		stderrCapture = [];
		await postCompact({ hook_type: "PostCompact" });
		const postStderr = stderrCapture.join("");
		expect(postStderr).toContain("PENDING FIXES");
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

describe("Scenario 15: Init creates empty gates, session-start prompts detection", () => {
	it("init writes empty gates.json, session-start prompts /qult:detect-gates", async () => {
		// Init writes empty gates.json (Skill will fill it later)
		writeFileSync(join(QULT_DIR, "gates.json"), "{}");

		const { loadGates } = await import("../gates/load.ts");
		const loaded = loadGates();
		expect(loaded).not.toBeNull();
		expect(Object.keys(loaded!.on_write ?? {})).toHaveLength(0);
		expect(Object.keys(loaded!.on_commit ?? {})).toHaveLength(0);
	});

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

		// Stop should block — no review has been run (small plan: incomplete tasks only warn)
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		const reason = (response as Record<string, string>)?.reason;
		expect(reason).toContain("review");

		// Now mark all as done + record review
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
		const { recordReview: rr16 } = await import("../state/session-state.ts");
		rr16();

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
			prompt:
				"add comprehensive logging with structured output, log levels, file rotation, request tracing, correlation IDs, error context capture, performance timing, integration with monitoring dashboard including alerts, custom metrics, distributed tracing spans, log aggregation pipeline, and retention policy configuration",
		});
		const planResponse = getResponse();
		const template = (planResponse?.hookSpecificOutput as Record<string, string>)
			?.additionalContext;
		expect(template).toContain("## Tasks");
		expect(template).toContain("Verify");

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

		// Step 5: Record review + Stop should allow
		const { recordReview: rr17 } = await import("../state/session-state.ts");
		rr17();
		stdoutCapture = [];
		exitCode = null;
		await stop({ hook_type: "Stop" });
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// TaskCompleted integration scenarios
// ============================================================

describe("Scenario 18: Plan completion unblocks stop", () => {
	it("marking tasks done and review allows stop", async () => {
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

		// Stop should block (incomplete tasks)
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);

		// Manually mark tasks as done + check review
		writeFileSync(
			join(planDir, "feature.md"),
			[
				"## Tasks",
				"### Task 1: Add logger [done]",
				"- File: src/logger.ts",
				"",
				"### Task 2: Add tests [done]",
				"- File: src/__tests__/logger.test.ts",
				"",
				"## Review Gates",
				"- [x] Final Review",
			].join("\n"),
		);

		// Record review + Now stop should allow
		const { recordReview: rr18 } = await import("../state/session-state.ts");
		rr18();
		stdoutCapture = [];
		exitCode = null;
		await stop({ hook_type: "Stop" });
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// Hook completeness scenarios
// ============================================================

describe("Scenario 19: SubagentStart injects pending-fixes state", () => {
	it("subagents receive pending-fixes warning", async () => {
		const { writePendingFixes: wpf } = await import("../state/pending-fixes.ts");
		wpf([{ file: "src/broken.ts", errors: ["type error"], gate: "typecheck" }]);

		const subagentStart = (await import("../hooks/subagent-start.ts")).default;
		await subagentStart({ hook_type: "SubagentStart" });

		const response = getResponse();
		const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
		expect(context).toBeDefined();
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

describe("Scenario 21: ConfigChange blocks hook modification", () => {
	it("prevents Claude from removing hooks", async () => {
		const configChange = (await import("../hooks/config-change.ts")).default;
		try {
			await configChange({
				hook_type: "ConfigChange",
				tool_input: { source: "user_settings", key: "hooks" },
			});
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);
	});

	it("allows non-hook user_settings changes", async () => {
		const configChange = (await import("../hooks/config-change.ts")).default;
		await configChange({
			hook_type: "ConfigChange",
			tool_input: { source: "user_settings", key: "model" },
		});
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// Doctor integration scenario
// ============================================================

describe("Scenario 23: Init → Doctor reports all OK", () => {
	it("doctor passes after valid init-like setup", async () => {
		// Simulate what init does: create gates.json + .state
		const gates = { on_write: { lint: { command: "echo ok", timeout: 3000 } } };
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));

		// Point HOME to test dir for doctor to find settings
		const originalHome = process.env.HOME;
		process.env.HOME = TEST_DIR;

		try {
			const claudeDir = join(TEST_DIR, ".claude");
			mkdirSync(join(claudeDir, "skills", "qult-review"), { recursive: true });
			mkdirSync(join(claudeDir, "skills", "qult-plan-review"), { recursive: true });
			mkdirSync(join(claudeDir, "skills", "qult-detect-gates"), { recursive: true });
			mkdirSync(join(claudeDir, "skills", "qult-plan-generator"), { recursive: true });
			mkdirSync(join(claudeDir, "agents"), { recursive: true });
			mkdirSync(join(claudeDir, "rules"), { recursive: true });
			writeFileSync(join(claudeDir, "skills", "qult-review", "SKILL.md"), "# skill");
			writeFileSync(join(claudeDir, "skills", "qult-plan-review", "SKILL.md"), "# skill");
			writeFileSync(join(claudeDir, "skills", "qult-detect-gates", "SKILL.md"), "# skill");
			writeFileSync(join(claudeDir, "skills", "qult-plan-generator", "SKILL.md"), "# skill");
			writeFileSync(join(claudeDir, "agents", "qult-reviewer.md"), "# agent");
			writeFileSync(join(claudeDir, "agents", "qult-plan-evaluator.md"), "# agent");
			writeFileSync(join(claudeDir, "agents", "qult-plan-generator.md"), "# agent");
			writeFileSync(join(claudeDir, "rules", "qult-quality.md"), "# rules");

			// Write settings.json with all 12 hooks
			const { QULT_HOOKS } = await import("../init.ts");
			const hooks: Record<string, unknown> = {};
			for (const event of Object.keys(QULT_HOOKS)) {
				hooks[event] = QULT_HOOKS[event];
			}
			writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ hooks }));

			// Run doctor
			const { runChecks } = await import("../doctor.ts");
			const results = runChecks();

			expect(results).toHaveLength(12);

			// All checks should be ok (except path which may be warn)
			const failures = results.filter((r) => r.status === "fail");
			expect(failures).toHaveLength(0);

			// Verify key checks explicitly
			const hooksCheck = results.find((r) => r.name === "hooks");
			expect(hooksCheck!.status).toBe("ok");
			expect(hooksCheck!.message).toContain("12/12");

			const gatesCheck = results.find((r) => r.name === "gates");
			expect(gatesCheck!.status).toBe("ok");
		} finally {
			process.env.HOME = originalHome;
		}
	});
});

// ============================================================
// run_once_per_batch scenario
// ============================================================

describe("Scenario 24: run_once_per_batch skips typecheck on 2nd edit", () => {
	it("typecheck runs once, clears on commit", async () => {
		const gates = {
			on_write: {
				lint: { command: "echo lint-ok", timeout: 3000 },
				typecheck: { command: "echo typecheck-ok", timeout: 3000, run_once_per_batch: true },
			},
		};
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));

		const { clearOnCommit, readSessionState } = await import("../state/session-state.ts");
		clearOnCommit();

		const postTool = (await import("../hooks/post-tool.ts")).default;

		// First edit — both gates run, typecheck marked in batch
		await postTool({
			hook_type: "PostToolUse",
			session_id: "test-session",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/a.ts") },
		});

		const state1 = readSessionState();
		expect(state1.ran_gates.typecheck).toBeDefined();
		expect(state1.ran_gates.typecheck!.session_id).toBe("test-session");

		// Second edit — typecheck skipped (batch hit), lint still runs
		stdoutCapture = [];
		await postTool({
			hook_type: "PostToolUse",
			session_id: "test-session",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/b.ts") },
		});

		// Batch still has typecheck entry
		const state2 = readSessionState();
		expect(state2.ran_gates.typecheck!.session_id).toBe("test-session");

		// Git commit — clears batch
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
// SubagentStop verification scenario
// ============================================================

describe("Scenario 25: SubagentStop blocks incomplete reviewer output", () => {
	it("blocks reviewer without findings, allows with findings", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;

		// Incomplete reviewer output → block
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

		// Valid reviewer output → allow
		stdoutCapture = [];
		exitCode = null;
		await subagentStop({
			hook_type: "SubagentStop",
			agent_type: "qult-reviewer",
			last_assistant_message: "- [medium] src/foo.ts:10 — unused variable\n  Fix: remove it",
		});
		expect(exitCode).toBeNull();

		// Unknown agent → allow (fail-open)
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
// Phase Gate: test pass required before commit
// ============================================================

describe("Scenario 26: git commit DENIED without test pass", () => {
	it("blocks commit without test pass, allows after test pass", async () => {
		// Need on_commit gate for test-before-commit enforcement
		const gates: GatesConfig = {
			on_write: { lint: { command: "echo 'OK' && exit 0", timeout: 3000 } },
			on_commit: { test: { command: "echo 'OK' && exit 0", timeout: 3000 } },
		};
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));

		// Create a plan so that review is required
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(join(planDir, "test-plan.md"), "## Tasks\n### Task 1: implement [done]\n");

		const { clearOnCommit, recordTestPass } = await import("../state/session-state.ts");
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

		// Record test pass but no review → still DENY (plan active = review required)
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

		// Record review → now allow
		const { recordReview, readLastTestPass } = await import("../state/session-state.ts");
		recordReview();
		stdoutCapture = [];
		exitCode = null;
		await preTool({
			hook_type: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "git commit -m 'test'" },
		});
		expect(exitCode).toBeNull();

		// PostToolUse git commit → clears test pass
		const postTool = (await import("../hooks/post-tool.ts")).default;
		stdoutCapture = [];
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "git commit -m 'done'" },
		});

		expect(readLastTestPass()).toBeNull();
	});
});

// ============================================================
// Independent review required before stop (Plan active)
// ============================================================

describe("Scenario 27: Stop blocks without review when plan exists", () => {
	it("blocks without review, allows after review", async () => {
		// Create a plan with all tasks done + review gates checked
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "review-test.md"),
			[
				"## Tasks",
				"### Task 1: Add feature [done]",
				"- **File**: src/feature.ts",
				"- **Verify**: src/__tests__/feature.test.ts:test",
				"## Review Gates",
				"- [x] Final Review",
			].join("\n"),
		);

		const { clearOnCommit: clearReview27, recordReview } = await import(
			"../state/session-state.ts"
		);
		clearReview27();

		const stop = (await import("../hooks/stop.ts")).default;

		// Stop should block — plan exists but no review
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);

		// Record review (simulating qult-reviewer completion)
		recordReview();

		// Stop should allow now
		stdoutCapture = [];
		exitCode = null;
		await stop({ hook_type: "Stop" });
		expect(exitCode).toBeNull();
	});
});

describe("Scenario 28: DENY effectiveness — resolution tracked when fix clears pending", () => {
	it("records resolution after DENY followed by fix", async () => {
		setupFailingLintGate();
		const postTool = (await import("../hooks/post-tool.ts")).default;
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		const { readMetrics } = await import("../state/metrics.ts");

		// Step 1: Edit file A → lint fails → pending-fixes created
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "a.ts") },
			session_id: "s1",
		});
		const fixes = readPendingFixes();
		expect(fixes.length).toBe(1);

		// Step 2: Try to edit file B → DENY
		stdoutCapture = [];
		try {
			await preTool({
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "b.ts") },
			});
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);

		// Step 3: Fix file A (switch to passing gates)
		setupPassingGates();
		exitCode = null;
		stdoutCapture = [];
		await postTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "a.ts") },
			session_id: "s1",
		});

		// Pending-fixes should be empty now
		expect(readPendingFixes().length).toBe(0);

		// Metrics should contain both a deny and a resolution
		flushAll();
		const metrics = readMetrics();
		const denies = metrics.filter((m) => m.action.endsWith(":deny"));
		const resolutions = metrics.filter((m) => m.action.endsWith(":resolution"));
		expect(denies.length).toBeGreaterThanOrEqual(1);
		expect(resolutions.length).toBeGreaterThanOrEqual(1);
	});
});

// ============================================================
// Adaptive Sprint contract scenarios
// ============================================================

describe("Scenario 29: Small plan (≤3 tasks) — ExitPlanMode allows without Success Criteria", () => {
	it("small plan passes without Success Criteria", async () => {
		const plansDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(plansDir, { recursive: true });
		writeFileSync(
			join(plansDir, "plan.md"),
			[
				"## Context",
				"Fix two small bugs.",
				"",
				"### Task 1: Fix typo [pending]",
				"- **File**: src/foo.ts",
				"- **Change**: Fix typo",
				"",
				"### Task 2: Fix import [pending]",
				"- **File**: src/bar.ts",
				"- **Change**: Fix import",
				"",
				"## Review Gates",
				"- [ ] Final Review: run /qult:review",
			].join("\n"),
		);

		const permissionRequest = (await import("../hooks/permission-request.ts")).default;
		await permissionRequest({
			tool: { name: "ExitPlanMode" },
		});

		// Should NOT exit with code 2 — small plan doesn't need Success Criteria
		expect(exitCode).toBeNull();
	});
});

describe("Scenario 30: Small plan — Stop warns instead of blocking for incomplete tasks", () => {
	it("small plan with incomplete tasks warns via stderr, does not block", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "small-plan.md"),
			["## Tasks", "### Task 1: Fix typo [done]", "### Task 2: Fix import [pending]"].join("\n"),
		);

		// Record review so review check doesn't block
		const { recordReview } = await import("../state/session-state.ts");
		recordReview();

		const stop = (await import("../hooks/stop.ts")).default;
		await stop({ hook_type: "Stop" });

		// Small plan (2 tasks + 0 checkboxes = 2 items ≤ 3): warn only, no block
		expect(exitCode).toBeNull();
		const stderr = stderrCapture.join("");
		expect(stderr).toContain("incomplete");
	});
});

// ============================================================
// Phase 5: Reviewer precision & Planner quality scenarios
// ============================================================

describe("Scenario 32: Reviewer findings recorded in metrics with severity breakdown", () => {
	it("FAIL with mixed-severity findings stores detail in metrics", async () => {
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify({}));
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		const { readMetrics } = await import("../state/metrics.ts");

		const reviewerOutput = [
			"[critical] src/auth.ts:42 — SQL injection in login query",
			"Fix: Use parameterized queries",
			"",
			"[high] src/api.ts:10 — Missing input validation",
			"Fix: Add zod schema",
			"",
			"[low] src/utils.ts:5 — Unused import",
			"Fix: Remove it",
			"",
			"Review: FAIL",
			"Score: Correctness=2 Design=4 Security=2",
		].join("\n");

		try {
			await subagentStop({
				hook_type: "SubagentStop",
				agent_type: "qult-reviewer",
				last_assistant_message: reviewerOutput,
			});
		} catch {
			// exit(2) from block on FAIL
		}

		flushAll();
		const metrics = readMetrics();
		const reviewEntry = metrics.find((m) => m.action === "review:fail");
		expect(reviewEntry).toBeDefined();
		expect(reviewEntry!.detail).toBeDefined();
		expect(reviewEntry!.detail!.total).toBe(3);
		expect(reviewEntry!.detail!.critical).toBe(1);
		expect(reviewEntry!.detail!.high).toBe(1);
		expect(reviewEntry!.detail!.low).toBe(1);
		expect(reviewEntry!.detail!.medium).toBe(0);
	});

	it("PASS with no findings stores zero total", async () => {
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify({}));
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;
		const { readMetrics } = await import("../state/metrics.ts");

		const reviewerOutput = [
			"No issues found.",
			"",
			"Review: PASS",
			"Score: Correctness=5 Design=5 Security=5",
		].join("\n");

		await subagentStop({
			hook_type: "SubagentStop",
			agent_type: "qult-reviewer",
			last_assistant_message: reviewerOutput,
		});

		flushAll();
		const metrics = readMetrics();
		const reviewEntry = metrics.find((m) => m.action === "review:pass");
		expect(reviewEntry).toBeDefined();
		expect(reviewEntry!.detail).toBeDefined();
		expect(reviewEntry!.detail!.total).toBe(0);
	});
});

describe("Scenario 33: Plan template includes Boundary and SIZE guidance", () => {
	it("plan mode full template contains Boundary field and LOC guidance", async () => {
		const userPrompt = (await import("../hooks/user-prompt.ts")).default;

		await userPrompt({
			hook_type: "UserPromptSubmit",
			permission_mode: "plan",
			prompt:
				"implement authentication with JWT tokens, add login and signup endpoints, middleware for protected routes, " +
				"password hashing with bcrypt, update user model with password fields, add rate limiting on auth endpoints, " +
				"create integration tests for all auth flows, update API documentation with auth examples, " +
				"add refresh token rotation logic, implement CORS configuration for frontend origin, " +
				"set up email verification flow with confirmation links and expiry tokens",
		});

		const response = getResponse();
		expect(response).not.toBeNull();
		const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
		expect(context).toContain("Boundary");
		expect(context).toContain("15 LOC");
	});
});

describe("Scenario 34: Large plan without File field is DENIED", () => {
	it("4-task plan missing File field on a task → DENY", async () => {
		const permReq = (await import("../hooks/permission-request.ts")).default;
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });

		writeFileSync(
			join(planDir, "no-file-field.md"),
			[
				"## Tasks",
				"### Task 1: Add feature",
				"- **File**: src/feature.ts",
				"- **Verify**: src/__tests__/feature.test.ts:testFeature",
				"### Task 2: Add model",
				"- **Change**: update the model",
				"- **Verify**: src/__tests__/model.test.ts:testModel",
				"### Task 3: Add service",
				"- **File**: src/service.ts",
				"- **Verify**: src/__tests__/service.test.ts:testService",
				"### Task 4: Add controller",
				"- **File**: src/controller.ts",
				"- **Verify**: src/__tests__/controller.test.ts:testController",
				"",
				"## Success Criteria",
				"- [ ] `bun vitest run` — all scenarios pass",
			].join("\n"),
		);

		try {
			await permReq({ hook_type: "PermissionRequest", tool: { name: "ExitPlanMode" } });
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		const reason = (response?.hookSpecificOutput as Record<string, string>)
			?.permissionDecisionReason;
		expect(reason).toContain("File");
		expect(reason).toContain("Add model");
	});

	it("small plan (≤3 tasks) passes without File field", async () => {
		const permReq = (await import("../hooks/permission-request.ts")).default;
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });

		writeFileSync(
			join(planDir, "small-no-file.md"),
			[
				"## Tasks",
				"### Task 1: Quick fix",
				"- **Change**: fix the bug",
				"### Task 2: Add test",
				"- **Change**: add test case",
			].join("\n"),
		);

		await permReq({ hook_type: "PermissionRequest", tool: { name: "ExitPlanMode" } });
		expect(exitCode).toBeNull();
	});
});

describe("Scenario 35: biome check --write clears stale pending-fixes", () => {
	it("lint fix with --write triggers revalidation and clears pending-fixes", async () => {
		setupFailingLintGate();
		const postTool = (await import("../hooks/post-tool.ts")).default;

		// Step 1: Edit file → lint fails → pending-fixes created
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});
		expect(readPendingFixes().length).toBeGreaterThan(0);

		// Step 2: Switch to passing gates (simulates the fix having been applied)
		setupPassingGates();
		stdoutCapture = [];

		// Step 3: Run biome check --write → should revalidate and clear pending-fixes
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "biome check --write src/foo.ts" },
		});

		expect(readPendingFixes()).toHaveLength(0);
	});
});

// ============================================================
// Phase 6: Plan contract enforcement scenarios
// ============================================================

function setupLargePlan(planDir: string, content: string): void {
	mkdirSync(planDir, { recursive: true });
	writeFileSync(join(planDir, "contract-plan.md"), content);
}

const LARGE_PLAN_4TASKS = [
	"## Tasks",
	"### Task 1: Add auth [done]",
	"- **File**: src/auth.ts",
	"- **Verify**: src/__tests__/auth.test.ts:testLogin",
	"### Task 2: Add routes [done]",
	"- **File**: src/routes.ts",
	"- **Verify**: src/__tests__/routes.test.ts:testRoutes",
	"### Task 3: Add middleware [done]",
	"- **File**: src/middleware.ts",
	"- **Verify**: src/__tests__/middleware.test.ts:testMiddleware",
	"### Task 4: Add config [done]",
	"- **File**: src/config.ts",
	"- **Verify**: src/__tests__/config.test.ts:testConfig",
	"",
	"## Success Criteria",
	"- [x] `bun vitest run` — all tests pass",
	"- [x] `bun tsc --noEmit` — no type errors",
].join("\n");

describe("Scenario 36: Stop blocks on unverified fields (large plan)", () => {
	it("blocks when verify fields not executed", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		setupLargePlan(planDir, LARGE_PLAN_4TASKS);
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify({}));

		const { recordReview, recordCriteriaCommand } = await import("../state/session-state.ts");
		recordReview();
		recordCriteriaCommand("bun vitest run");
		recordCriteriaCommand("bun tsc --noEmit");

		const stop = (await import("../hooks/stop.ts")).default;
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		const reason = (response as Record<string, string>)?.reason;
		expect(reason).toContain("verify");
	});

	it("allows when all verify fields have been recorded", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		setupLargePlan(planDir, LARGE_PLAN_4TASKS);
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify({}));

		const { recordVerifiedField, recordReview, recordCriteriaCommand } = await import(
			"../state/session-state.ts"
		);
		recordVerifiedField("Add auth:testLogin");
		recordVerifiedField("Add routes:testRoutes");
		recordVerifiedField("Add middleware:testMiddleware");
		recordVerifiedField("Add config:testConfig");
		recordCriteriaCommand("bun vitest run");
		recordCriteriaCommand("bun tsc --noEmit");
		recordReview();

		const stop = (await import("../hooks/stop.ts")).default;
		await stop({ hook_type: "Stop" });
		expect(exitCode).toBeNull();
	});
});

describe("Scenario 37: File divergence warning", () => {
	it("warns when many unplanned files changed", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		const smallPlan = [
			"## Tasks",
			"### Task 1: Add feature [done]",
			"- **File**: src/feature.ts",
		].join("\n");
		setupLargePlan(planDir, smallPlan);
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify({}));

		const { recordChangedFile, recordReview } = await import("../state/session-state.ts");
		recordChangedFile("/project/src/feature.ts");
		recordChangedFile("/project/src/unplanned1.ts");
		recordChangedFile("/project/src/unplanned2.ts");
		recordChangedFile("/project/src/unplanned3.ts");
		recordReview();

		const stop = (await import("../hooks/stop.ts")).default;
		await stop({ hook_type: "Stop" });

		// Advisory only — should NOT block
		expect(exitCode).toBeNull();
		const stderr = stderrCapture.join("");
		expect(stderr).toContain("scope creep");
	});
});

describe("Scenario 38: Stop blocks on unexecuted criteria commands (large plan)", () => {
	it("blocks when criteria commands not executed", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		setupLargePlan(planDir, LARGE_PLAN_4TASKS);
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify({}));

		const { recordVerifiedField, recordReview } = await import("../state/session-state.ts");
		recordVerifiedField("Add auth:testLogin");
		recordVerifiedField("Add routes:testRoutes");
		recordVerifiedField("Add middleware:testMiddleware");
		recordVerifiedField("Add config:testConfig");
		recordReview();
		// NOT recording criteria commands

		const stop = (await import("../hooks/stop.ts")).default;
		try {
			await stop({ hook_type: "Stop" });
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		const reason = (response as Record<string, string>)?.reason;
		expect(reason).toContain("Success Criteria");
	});
});

describe("Scenario 39: Small plan — contract checks warn only, never block", () => {
	it("small plan with unverified fields and unexecuted criteria only warns", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		const smallPlan = [
			"## Tasks",
			"### Task 1: Fix bug [done]",
			"- **File**: src/bug.ts",
			"- **Verify**: src/__tests__/bug.test.ts:testBug",
			"## Success Criteria",
			"- [ ] `bun vitest run` — tests pass",
		].join("\n");
		setupLargePlan(planDir, smallPlan);
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify({}));

		const { recordReview } = await import("../state/session-state.ts");
		recordReview();

		const stop = (await import("../hooks/stop.ts")).default;
		await stop({ hook_type: "Stop" });

		// Small plan: warn only, no block
		expect(exitCode).toBeNull();
		const stderr = stderrCapture.join("");
		expect(stderr).toContain("verify");
		expect(stderr).toContain("Success Criteria");
	});
});

describe("Scenario: Review score threshold — PASS with high scores clears gate", () => {
	it("aggregate 14/15 proceeds past threshold", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;

		await subagentStop({
			agent_type: "qult-reviewer",
			last_assistant_message: [
				"Review: PASS",
				"Score: Correctness=5 Design=5 Security=4",
				"No issues found.",
			].join("\n"),
		});

		// Should not block — aggregate 14 >= threshold 12
		expect(exitCode).toBeNull();
	});
});

describe("Scenario: Review score threshold — PASS with low scores blocks", () => {
	it("aggregate 9/15 blocks with below-threshold message", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;

		try {
			await subagentStop({
				agent_type: "qult-reviewer",
				last_assistant_message: [
					"Review: PASS",
					"Score: Correctness=3 Design=3 Security=3",
					"No issues found.",
				].join("\n"),
			});
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
		const stderr = stderrCapture.join("");
		expect(stderr).toContain("below threshold");
		expect(stderr).toContain("9/15");
	});
});

describe("Scenario: Review score threshold — max iterations reached proceeds", () => {
	it("aggregate 9/15 after max iterations falls through (fail-open ceiling)", async () => {
		// Simulate 2 prior iterations (iteration count = 2 after these).
		// subagentStop will increment to 3 = maxIter, so iterCount < maxIter is false → fall through.
		const { recordReviewIteration } = await import("../state/session-state.ts");
		recordReviewIteration(9);
		recordReviewIteration(10);
		flushAll();
		resetAllCaches();

		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;

		await subagentStop({
			agent_type: "qult-reviewer",
			last_assistant_message: [
				"Review: PASS",
				"Score: Correctness=3 Design=3 Security=3",
				"No issues found.",
			].join("\n"),
		});

		// Should NOT block — max iterations (3) reached
		expect(exitCode).toBeNull();
	});
});

describe("Scenario: Review PASS without scores — fail-open", () => {
	it("PASS without parseable scores falls through to recordReview", async () => {
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;

		await subagentStop({
			agent_type: "qult-reviewer",
			last_assistant_message: "Review: PASS\nNo issues found.",
		});

		// Should not block — no scores = fail-open
		expect(exitCode).toBeNull();
	});
});

describe("Scenario: Large plan without plan evaluation is DENIED on ExitPlanMode", () => {
	it("DENY when plan_evaluated_at is null", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Context",
				"Adding auth system",
				"## Tasks",
				"### Task 1: Add login [pending]",
				"- **File**: src/login.ts",
				"- **Verify**: src/__tests__/login.test.ts:testLogin",
				"### Task 2: Add signup [pending]",
				"- **File**: src/signup.ts",
				"- **Verify**: src/__tests__/signup.test.ts:testSignup",
				"### Task 3: Add middleware [pending]",
				"- **File**: src/middleware.ts",
				"- **Verify**: src/__tests__/middleware.test.ts:testAuth",
				"### Task 4: Add rate limiting [pending]",
				"- **File**: src/rate.ts",
				"- **Verify**: src/__tests__/rate.test.ts:testLimit",
				"## Success Criteria",
				"- [ ] `bun vitest run` — all tests pass",
			].join("\n"),
		);

		const handler = (await import("../hooks/permission-request.ts")).default;
		try {
			await handler({ tool: { name: "ExitPlanMode" } });
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
		const stderr = stderrCapture.join("");
		expect(stderr).toContain("plan-review");
	});
});

describe("Scenario: Plan evaluator PASS clears gate → ExitPlanMode allowed", () => {
	it("full flow: plan-evaluator PASS → ExitPlanMode allowed", async () => {
		// Step 1: Plan evaluator PASS → records plan_evaluated_at
		const subagentStop = (await import("../hooks/subagent-stop.ts")).default;

		await subagentStop({
			agent_type: "qult-plan-evaluator",
			last_assistant_message: [
				"Plan: PASS",
				"PlanScore: Scope=4 Coherence=5 Verifiability=4",
				"No issues found.",
			].join("\n"),
		});

		expect(exitCode).toBeNull();
		flushAll();
		resetAllCaches();

		// Step 2: ExitPlanMode should now be allowed for a large plan
		stdoutCapture = [];
		stderrCapture = [];
		exitCode = null;

		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Context",
				"Adding auth system",
				"## Tasks",
				"### Task 1: Add login [pending]",
				"- **File**: src/login.ts",
				"- **Verify**: src/__tests__/login.test.ts:testLogin",
				"### Task 2: Add signup [pending]",
				"- **File**: src/signup.ts",
				"- **Verify**: src/__tests__/signup.test.ts:testSignup",
				"### Task 3: Add middleware [pending]",
				"- **File**: src/middleware.ts",
				"- **Verify**: src/__tests__/middleware.test.ts:testAuth",
				"### Task 4: Add rate limiting [pending]",
				"- **File**: src/rate.ts",
				"- **Verify**: src/__tests__/rate.test.ts:testLimit",
				"## Success Criteria",
				"- [ ] `bun vitest run` — all tests pass",
			].join("\n"),
		);

		const handler = (await import("../hooks/permission-request.ts")).default;
		await handler({ tool: { name: "ExitPlanMode" } });

		expect(exitCode).toBeNull();
	});
});

describe("Scenario: Non-gated file extensions are skipped", () => {
	it(".md file does not trigger biome gate or create pending-fixes", async () => {
		// Gates with biome → only covers .js/.ts/.tsx etc, not .md
		const gates: GatesConfig = {
			on_write: {
				lint: { command: "biome check {file} && exit 1", timeout: 3000 },
			},
		};
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));

		const postTool = (await import("../hooks/post-tool.ts")).default;
		const preTool = (await import("../hooks/pre-tool.ts")).default;

		// Step 1: Write a .md file — gate should be skipped entirely
		await postTool({
			tool_name: "Write",
			tool_input: { file_path: join(TEST_DIR, "docs/concept.md") },
		});

		const fixes = readPendingFixes();
		expect(fixes.length).toBe(0);

		// Step 2: No DENY when editing another file (no pending-fixes from .md)
		stdoutCapture = [];
		exitCode = null;
		await preTool({
			tool_name: "Edit",
			tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
		});
		expect(exitCode).toBeNull();
	});
});

// ============================================================
// False Positive Detection
// ============================================================

// ============================================================
// on_review gate integration
// ============================================================

describe("Scenario: Review skill template includes on_review gate execution step", () => {
	it("skill-review.md contains Stage 0 for on_review gates", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const templatePath = join(import.meta.dirname, "..", "templates", "skill-review.md");
		const content = readFileSync(templatePath, "utf-8");

		// Stage 0 exists and mentions on_review
		expect(content).toContain("Stage 0");
		expect(content).toContain("on_review");
		expect(content).toContain("gates.json");
		// Gate results are passed to reviewer
		expect(content).toContain("gate results");
		// Timeout enforcement is specified
		expect(content).toContain("timeout");
		// Stage 0 appears before Stage 1 (structural order)
		expect(content.indexOf("Stage 0")).toBeLessThan(content.indexOf("Stage 1"));
	});

	it("agent-reviewer.md references pre-provided gate results with fallback", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const templatePath = join(import.meta.dirname, "..", "templates", "agent-reviewer.md");
		const content = readFileSync(templatePath, "utf-8");

		// Reviewer knows about pre-provided gate results
		expect(content).toContain("gate results");
		expect(content).toContain("fallback");
		// Reviewer allowed-tools includes e2e patterns for fallback execution
		expect(content).toContain("npx playwright *");
		expect(content).toContain("npx cypress *");
	});
});

describe("Scenario: gates.json with on_review section loads correctly", () => {
	it("loadGates returns on_review gates", async () => {
		const gates: GatesConfig = {
			on_write: {
				lint: { command: "echo ok", timeout: 3000 },
			},
			on_review: {
				e2e: { command: "npx playwright test", timeout: 60000 },
			},
		};
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));

		const { loadGates } = await import("../gates/load.ts");
		const loaded = loadGates();
		expect(loaded).not.toBeNull();
		expect(loaded!.on_review).toBeDefined();
		expect(loaded!.on_review!.e2e).toBeDefined();
		expect(loaded!.on_review!.e2e!.command).toBe("npx playwright test");
		expect(loaded!.on_review!.e2e!.timeout).toBe(60000);
	});

	it("on_review is undefined when not configured in gates.json", async () => {
		const gates: GatesConfig = {
			on_write: {
				lint: { command: "echo ok", timeout: 3000 },
			},
		};
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));

		const { loadGates } = await import("../gates/load.ts");
		const loaded = loadGates();
		expect(loaded).not.toBeNull();
		expect(loaded!.on_review).toBeUndefined();
	});
});

describe("Scenario: Pace-red DENY followed by clean commit records false positive", () => {
	it("detects false positive when pace-red DENY is followed by clean commit", async () => {
		// Set up passing on_commit gates
		const gates: GatesConfig = {
			on_write: {
				lint: { command: "echo 'OK' && exit 0", timeout: 3000 },
			},
			on_commit: {
				test: { command: "echo 'pass' && exit 0", timeout: 3000 },
			},
		};
		writeFileSync(join(QULT_DIR, "gates.json"), JSON.stringify(gates));

		// Simulate pace-red state (120+ min, 16+ files)
		writePace({
			last_commit_at: new Date(Date.now() - 125 * 60_000).toISOString(),
			changed_files: 16,
			tool_calls: 80,
		});

		// Step 1: pre-tool DENY (pace-red) — records deny timestamp
		const preTool = (await import("../hooks/pre-tool.ts")).default;
		try {
			await preTool({
				hook_type: "PreToolUse",
				tool_name: "Edit",
				tool_input: { file_path: join(TEST_DIR, "src/foo.ts") },
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);

		// Verify deny timestamp was recorded
		const { readLastDeny } = await import("../state/session-state.ts");
		const lastDeny = readLastDeny();
		expect(lastDeny).not.toBeNull();
		expect(lastDeny!.reason).toBe("pace-red");

		// Step 2: User commits (simulating they reduced scope)
		// Reset pace so commit can proceed
		writePace({
			last_commit_at: new Date().toISOString(),
			changed_files: 0,
			tool_calls: 0,
		});

		stdoutCapture = [];
		exitCode = null;
		const postTool = (await import("../hooks/post-tool.ts")).default;
		await postTool({
			hook_type: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "git commit -m 'test commit'" },
		});

		// Flush caches to disk (handler doesn't call flushAll, dispatcher does)
		flushAll();

		// Step 3: Verify false-positive:detected metric was recorded
		const { readMetrics } = await import("../state/metrics.ts");
		const metrics = readMetrics();
		const fpEntries = metrics.filter((m) => m.action === "false-positive:detected");
		expect(fpEntries.length).toBeGreaterThanOrEqual(1);
		expect(fpEntries[0]!.reason).toBe("pace-red");
	});
});
