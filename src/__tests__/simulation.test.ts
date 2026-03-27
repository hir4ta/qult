import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPendingFixes } from "../state/pending-fixes.ts";
import { readPace, writePace } from "../state/session-state.ts";
import type { GatesConfig } from "../types.ts";

/**
 * End-to-end simulation of alfred hook flow.
 * Imports handlers directly and captures stdout/exit behavior.
 */

const TEST_DIR = join(import.meta.dirname, ".tmp-simulation");
const ALFRED_DIR = join(TEST_DIR, ".alfred");
const STATE_DIR = join(ALFRED_DIR, ".state");

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
		expect(context).toContain("1 file");
		expect(context).toContain("15 lines");
		expect(context).toContain("Verify");
		// Must contain success criteria
		expect(context).toContain("Success Criteria");
		// Must contain review gates (full template for 500+ chars)
		expect(context).toContain("Design Review");
		expect(context).toContain("Phase Review");
		expect(context).toContain("Final Review");
		expect(context).toContain("/alfred:review");
	});
});

describe("Scenario 7: Normal mode large task → advisory to use plan mode", () => {
	it("long prompt advises plan mode (no block)", async () => {
		const userPrompt = (await import("../hooks/user-prompt.ts")).default;

		// >800 chars to trigger advisory
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

		expect(exitCode).toBeNull(); // no block
		const response = getResponse();
		const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
		expect(context).toBeDefined();
		expect(context?.toLowerCase()).toContain("plan mode");
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

describe("Scenario 8: ExitPlanMode → plan without File field is DENIED", () => {
	it("plan with File field passes, plan without is denied", async () => {
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
				"## Success Criteria",
				"- [ ] `bun vitest run` all tests pass",
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
		expect(reason).toContain("File");
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
		expect((response as Record<string, string>)?.decision).toBe("block");
	});
});

describe("Scenario 11: Stop hook allows when clean", () => {
	it("Claude can stop normally when no pending fixes", async () => {
		const stop = (await import("../hooks/stop.ts")).default;

		await stop({ hook_type: "Stop" });

		expect(exitCode).toBeNull();
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
		expect(postStderr).toContain("pending lint/type fix");
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

describe("Scenario 22: SessionEnd logs pending fixes", () => {
	it("logs pending fixes to stderr on exit", async () => {
		const { writePendingFixes: wpf } = await import("../state/pending-fixes.ts");
		wpf([{ file: "src/wip.ts", errors: ["incomplete"], gate: "lint" }]);

		const sessionEnd = (await import("../hooks/session-end.ts")).default;
		stderrCapture = [];
		await sessionEnd({ hook_type: "SessionEnd" });

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("1 pending fix");
		expect(stderr).toContain("wip.ts");
	});
});

// ============================================================
// Doctor integration scenario
// ============================================================

describe("Scenario 23: Init → Doctor reports all OK", () => {
	it("doctor passes after valid init-like setup", async () => {
		// Simulate what init does: create gates.json + .state
		const gates = { on_write: { lint: { command: "echo ok", timeout: 3000 } } };
		writeFileSync(join(ALFRED_DIR, "gates.json"), JSON.stringify(gates));

		// Point HOME to test dir for doctor to find settings
		const originalHome = process.env.HOME;
		process.env.HOME = TEST_DIR;

		try {
			const claudeDir = join(TEST_DIR, ".claude");
			mkdirSync(join(claudeDir, "skills", "alfred-review"), { recursive: true });
			mkdirSync(join(claudeDir, "agents"), { recursive: true });
			mkdirSync(join(claudeDir, "rules"), { recursive: true });
			writeFileSync(join(claudeDir, "skills", "alfred-review", "SKILL.md"), "# skill");
			writeFileSync(join(claudeDir, "agents", "alfred-reviewer.md"), "# agent");
			writeFileSync(join(claudeDir, "rules", "alfred-quality.md"), "# rules");

			// Write settings.json with all 13 hooks
			const { ALFRED_HOOKS } = await import("../init.ts");
			const hooks: Record<string, unknown> = {};
			for (const event of Object.keys(ALFRED_HOOKS)) {
				hooks[event] = ALFRED_HOOKS[event];
			}
			writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ hooks }));

			// Run doctor
			const { runChecks } = await import("../doctor.ts");
			const results = runChecks();

			expect(results).toHaveLength(8);

			// All checks should be ok (except path which may be warn)
			const failures = results.filter((r) => r.status === "fail");
			expect(failures).toHaveLength(0);

			// Verify key checks explicitly
			const hooksCheck = results.find((r) => r.name === "hooks");
			expect(hooksCheck!.status).toBe("ok");
			expect(hooksCheck!.message).toContain("13/13");

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
		writeFileSync(join(ALFRED_DIR, "gates.json"), JSON.stringify(gates));

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
				agent_type: "alfred-reviewer",
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
			agent_type: "alfred-reviewer",
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
		writeFileSync(join(ALFRED_DIR, "gates.json"), JSON.stringify(gates));
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

		// Record test pass but no review → still DENY
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

		// Record review (simulating alfred-reviewer completion)
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
				"- [ ] Final Review: run /alfred:review",
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
