import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-perm-test");
let stdoutCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(TEST_DIR, { recursive: true });
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

describe("permissionRequest (ExitPlanMode)", () => {
	it("allows plan with review gates", async () => {
		// Write a plan file that includes review gates
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Context",
				"Adding new feature",
				"## Tasks",
				"### Task 1: Add helper [pending]",
				"- **File**: src/helper.ts",
				"- **Verify**: src/__tests__/helper.test.ts:testHelper",
				"## Success Criteria",
				"- [ ] `bun vitest run` all tests pass",
				"## Review Gates",
				"- [ ] Design Review",
				"- [ ] Final Review",
			].join("\n"),
		);

		const handler = (await import("../permission-request.ts")).default;
		await handler({
			hook_type: "PermissionRequest",
			tool: { name: "ExitPlanMode" },
		});

		// Should not deny
		expect(exitCode).toBeNull();
	});

	it("allows large plan without review gates (review is enforced mechanically)", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		// Large plan requires plan evaluation — set plan_evaluated_at
		const stateDir = join(TEST_DIR, ".qult", ".state");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "session-state.json"),
			JSON.stringify({ plan_evaluated_at: new Date().toISOString() }),
		);
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Context",
				"Adding new feature",
				"## Tasks",
				"### Task 1: Add helper",
				"- File: src/a.ts",
				"- Verify: src/__tests__/a.test.ts:test",
				"### Task 2: Add model",
				"- File: src/b.ts",
				"- Verify: src/__tests__/b.test.ts:test",
				"### Task 3: Add service",
				"- File: src/c.ts",
				"- Verify: src/__tests__/c.test.ts:test",
				"### Task 4: Add controller",
				"- File: src/d.ts",
				"- Verify: src/__tests__/d.test.ts:test",
				"## Success Criteria",
				"- [ ] `bun vitest run` all tests pass",
			].join("\n"),
		);

		const handler = (await import("../permission-request.ts")).default;
		await handler({
			hook_type: "PermissionRequest",
			tool: { name: "ExitPlanMode" },
		});

		expect(exitCode).toBeNull();
	});

	it("allows small plan without review gates or success criteria", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Context",
				"Quick fix",
				"## Tasks",
				"### Task 1: Add helper",
				"- File: src/helper.ts",
			].join("\n"),
		);

		const handler = (await import("../permission-request.ts")).default;
		await handler({
			hook_type: "PermissionRequest",
			tool: { name: "ExitPlanMode" },
		});

		expect(exitCode).toBeNull();
	});

	it("allows plan without explicit File field (models include paths naturally)", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add helper [pending]",
				"- Verify: src/__tests__/helper.test.ts:testHelper",
			].join("\n"),
		);

		const handler = (await import("../permission-request.ts")).default;
		await handler({ hook_type: "PermissionRequest", tool: { name: "ExitPlanMode" } });

		expect(exitCode).toBeNull();
	});

	it("denies large plan with tasks missing Verify field", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add helper [pending]",
				"- File: src/helper.ts",
				"### Task 2: Add model [pending]",
				"- File: src/model.ts",
				"### Task 3: Add service [pending]",
				"- File: src/service.ts",
				"### Task 4: Add controller [pending]",
				"- File: src/controller.ts",
				"## Success Criteria",
				"- [ ] `bun vitest run` all tests pass",
				"## Review Gates",
				"- [ ] Final Review",
			].join("\n"),
		);

		const handler = (await import("../permission-request.ts")).default;
		try {
			await handler({ hook_type: "PermissionRequest", tool: { name: "ExitPlanMode" } });
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		const reason = (response?.hookSpecificOutput as Record<string, string>)
			?.permissionDecisionReason;
		expect(reason).toContain("Verify");
	});

	it("allows well-structured plan with File + Verify + Success Criteria + Review Gates", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add helper [pending]",
				"- **File**: src/helper.ts",
				"- **Verify**: src/__tests__/helper.test.ts:testHelper",
				"## Success Criteria",
				"- [ ] `bun tsc --noEmit` no type errors",
				"## Review Gates",
				"- [ ] Final Review",
			].join("\n"),
		);

		const handler = (await import("../permission-request.ts")).default;
		await handler({ hook_type: "PermissionRequest", tool: { name: "ExitPlanMode" } });
		expect(exitCode).toBeNull();
	});

	it("denies large plan with generic Verify field (no specific file)", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add helper [pending]",
				"- **File**: src/helper.ts",
				"- **Verify**: テストが通ること",
				"### Task 2: Add model [pending]",
				"- **File**: src/model.ts",
				"- **Verify**: src/__tests__/model.test.ts:test",
				"### Task 3: Add service [pending]",
				"- **File**: src/service.ts",
				"- **Verify**: src/__tests__/service.test.ts:test",
				"### Task 4: Add controller [pending]",
				"- **File**: src/controller.ts",
				"- **Verify**: src/__tests__/controller.test.ts:test",
				"## Success Criteria",
				"- [ ] `bun vitest run` all tests pass",
				"## Review Gates",
				"- [ ] Final Review",
			].join("\n"),
		);

		const handler = (await import("../permission-request.ts")).default;
		try {
			await handler({ hook_type: "PermissionRequest", tool: { name: "ExitPlanMode" } });
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		const reason = (response?.hookSpecificOutput as Record<string, string>)
			?.permissionDecisionReason;
		expect(reason).toContain("specific file or command");
	});

	it("denies large plan without Success Criteria section", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add helper [pending]",
				"- **File**: src/helper.ts",
				"- **Verify**: src/__tests__/helper.test.ts:testHelper",
				"### Task 2: Add model [pending]",
				"- **File**: src/model.ts",
				"- **Verify**: src/__tests__/model.test.ts:test",
				"### Task 3: Add service [pending]",
				"- **File**: src/service.ts",
				"- **Verify**: src/__tests__/service.test.ts:test",
				"### Task 4: Add controller [pending]",
				"- **File**: src/controller.ts",
				"- **Verify**: src/__tests__/controller.test.ts:test",
				"## Review Gates",
				"- [ ] Final Review",
			].join("\n"),
		);

		const handler = (await import("../permission-request.ts")).default;
		try {
			await handler({ hook_type: "PermissionRequest", tool: { name: "ExitPlanMode" } });
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		const reason = (response?.hookSpecificOutput as Record<string, string>)
			?.permissionDecisionReason;
		expect(reason).toContain("Success Criteria");
	});

	it("denies large plan with generic Success Criteria", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add helper [pending]",
				"- **File**: src/helper.ts",
				"- **Verify**: src/__tests__/helper.test.ts:testHelper",
				"### Task 2: Add model [pending]",
				"- **File**: src/model.ts",
				"- **Verify**: src/__tests__/model.test.ts:test",
				"### Task 3: Add service [pending]",
				"- **File**: src/service.ts",
				"- **Verify**: src/__tests__/service.test.ts:test",
				"### Task 4: Add controller [pending]",
				"- **File**: src/controller.ts",
				"- **Verify**: src/__tests__/controller.test.ts:test",
				"## Success Criteria",
				"- [ ] テストが通る",
				"## Review Gates",
				"- [ ] Final Review",
			].join("\n"),
		);

		const handler = (await import("../permission-request.ts")).default;
		try {
			await handler({ hook_type: "PermissionRequest", tool: { name: "ExitPlanMode" } });
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
		const response = getResponse();
		const reason = (response?.hookSpecificOutput as Record<string, string>)
			?.permissionDecisionReason;
		expect(reason).toContain("Success Criteria");
	});

	it("allows plan with concrete Success Criteria", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			[
				"## Tasks",
				"### Task 1: Add helper [pending]",
				"- **File**: src/helper.ts",
				"- **Verify**: src/__tests__/helper.test.ts:testHelper",
				"## Success Criteria",
				"- [ ] `bun vitest run` all tests pass",
				"- [ ] `bun tsc --noEmit` no type errors",
				"## Review Gates",
				"- [ ] Final Review",
			].join("\n"),
		);

		const handler = (await import("../permission-request.ts")).default;
		await handler({ hook_type: "PermissionRequest", tool: { name: "ExitPlanMode" } });
		expect(exitCode).toBeNull();
	});

	it("denies large plan with vague Success Criteria like 'tests pass'", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "vague-plan.md"),
			[
				"## Context",
				"Add auth",
				"## Tasks",
				"### Task 1: Add login [pending]",
				"- **Verify**: src/__tests__/auth.test.ts:testLogin",
				"### Task 2: Add signup [pending]",
				"- **Verify**: src/__tests__/auth.test.ts:testSignup",
				"### Task 3: Add middleware [pending]",
				"- **Verify**: src/__tests__/middleware.test.ts:testAuth",
				"### Task 4: Add rate limiting [pending]",
				"- **Verify**: src/__tests__/rate.test.ts:testLimit",
				"## Success Criteria",
				"- [ ] `bun vitest run` — all tests pass",
				"- [ ] tests pass",
			].join("\n"),
		);

		const handler = (await import("../permission-request.ts")).default;
		try {
			await handler({ hook_type: "PermissionRequest", tool: { name: "ExitPlanMode" } });
		} catch {
			// exit(2)
		}
		expect(exitCode).toBe(2);
		const output = stdoutCapture.join("");
		expect(output).toContain("vague");
	});

	it("ignores non-ExitPlanMode events", async () => {
		const handler = (await import("../permission-request.ts")).default;
		await handler({
			hook_type: "PermissionRequest",
			tool: { name: "Bash" },
		});

		expect(exitCode).toBeNull();
		expect(stdoutCapture.join("")).toBe("");
	});
});
