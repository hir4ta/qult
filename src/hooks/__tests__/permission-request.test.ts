import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-perm-test");
let stdoutCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
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
				"### Task 1: Add helper",
				"- File: src/helper.ts",
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

	it("denies plan without review gates", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "test-plan.md"),
			["## Context", "Adding new feature", "## Tasks", "### Task 1: Add helper"].join("\n"),
		);

		const handler = (await import("../permission-request.ts")).default;
		try {
			await handler({
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
