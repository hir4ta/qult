import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPace, writePace } from "../state/pace.ts";
import { readPendingFixes } from "../state/pending-fixes.ts";
import type { GatesConfig, HookEvent } from "../types.ts";

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
