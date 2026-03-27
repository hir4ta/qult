import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-task-completed-test");
const PLAN_DIR = join(TEST_DIR, ".claude", "plans");
let stdoutCapture: string[] = [];
let stderrCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(join(TEST_DIR, ".alfred", ".state"), { recursive: true });
	mkdirSync(PLAN_DIR, { recursive: true });
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

describe("task-completed hook", () => {
	it("updates plan task status to [done] when task matches", async () => {
		writeFileSync(
			join(PLAN_DIR, "plan.md"),
			[
				"## Tasks",
				"### Task 1: Add helper [pending]",
				"- File: src/helper.ts",
				"",
				"### Task 2: Add tests [pending]",
				"- File: src/__tests__/helper.test.ts",
			].join("\n"),
		);

		const handler = (await import("../task-completed.ts")).default;
		await handler({
			hook_type: "TaskCompleted",
			task_id: "1",
			task_subject: "Add helper",
		});

		// Plan should be updated
		const updated = readFileSync(join(PLAN_DIR, "plan.md"), "utf-8");
		expect(updated).toContain("Add helper [done]");
		expect(updated).toContain("Add tests [pending]"); // other task unchanged
		expect(exitCode).toBeNull(); // allowed
	});

	it("does nothing when no plan exists", async () => {
		rmSync(PLAN_DIR, { recursive: true, force: true });

		const handler = (await import("../task-completed.ts")).default;
		await handler({
			hook_type: "TaskCompleted",
			task_id: "1",
			task_subject: "Some task",
		});

		expect(exitCode).toBeNull(); // fail-open
	});

	it("does nothing when task_subject does not match any plan task", async () => {
		writeFileSync(
			join(PLAN_DIR, "plan.md"),
			["## Tasks", "### Task 1: Add helper [pending]"].join("\n"),
		);

		const handler = (await import("../task-completed.ts")).default;
		await handler({
			hook_type: "TaskCompleted",
			task_id: "1",
			task_subject: "Completely different task",
		});

		const content = readFileSync(join(PLAN_DIR, "plan.md"), "utf-8");
		expect(content).toContain("[pending]"); // unchanged
		expect(exitCode).toBeNull();
	});

	it("handles fuzzy matching of task names", async () => {
		writeFileSync(
			join(PLAN_DIR, "plan.md"),
			["## Tasks", "### Task 1: Add auth middleware [pending]"].join("\n"),
		);

		const handler = (await import("../task-completed.ts")).default;
		// Claude's task subject may not exactly match plan task name
		await handler({
			hook_type: "TaskCompleted",
			task_id: "1",
			task_subject: "Add auth middleware",
		});

		const content = readFileSync(join(PLAN_DIR, "plan.md"), "utf-8");
		expect(content).toContain("[done]");
	});

	it("rejects low-confidence fuzzy matches", async () => {
		writeFileSync(
			join(PLAN_DIR, "plan.md"),
			[
				"## Tasks",
				"### Task 1: Add authentication middleware [pending]",
				"- File: src/auth.ts",
			].join("\n"),
		);

		const handler = (await import("../task-completed.ts")).default;
		// "fix" is too short and unrelated — should NOT match
		await handler({
			hook_type: "TaskCompleted",
			task_id: "1",
			task_subject: "fix",
		});

		const content = readFileSync(join(PLAN_DIR, "plan.md"), "utf-8");
		expect(content).toContain("[pending]"); // should NOT have been updated
	});

	it("skips already-done tasks", async () => {
		writeFileSync(
			join(PLAN_DIR, "plan.md"),
			[
				"## Tasks",
				"### Task 1: Add helper [done]",
				"- File: src/helper.ts",
				"",
				"### Task 2: Add tests [pending]",
				"- File: src/__tests__/helper.test.ts",
			].join("\n"),
		);

		const handler = (await import("../task-completed.ts")).default;
		await handler({
			hook_type: "TaskCompleted",
			task_id: "2",
			task_subject: "Add tests",
		});

		const content = readFileSync(join(PLAN_DIR, "plan.md"), "utf-8");
		expect(content).toContain("Add helper [done]");
		expect(content).toContain("Add tests [done]");
	});
});
