import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "", pid: 0, output: [], signal: null })),
}));

const mockedSpawnSync = vi.mocked(spawnSync);

const TEST_DIR = join(import.meta.dirname, ".tmp-task-completed-test");
const STATE_DIR = join(TEST_DIR, ".qult", ".state");
let stdoutCapture: string[] = [];
let stderrCapture: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(STATE_DIR, { recursive: true });
	process.chdir(TEST_DIR);
	stdoutCapture = [];
	mockedSpawnSync.mockReset();
	mockedSpawnSync.mockReturnValue({
		status: 0,
		stdout: "",
		stderr: "",
		pid: 0,
		output: [],
		signal: null,
	} as ReturnType<typeof spawnSync>);

	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
	stderrCapture = [];
	vi.spyOn(process.stderr, "write").mockImplementation((data) => {
		stderrCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

function writePlan(content: string): void {
	const planDir = join(TEST_DIR, ".claude", "plans");
	mkdirSync(planDir, { recursive: true });
	writeFileSync(join(planDir, "test-plan.md"), content);
}

function writeGates(gates: Record<string, unknown>): void {
	writeFileSync(join(TEST_DIR, ".qult", "gates.json"), JSON.stringify(gates));
}

const PLAN_WITH_VERIFY = `## Context
Test feature

## Tasks
### Task 1: Add handler [pending]
- **File**: src/handler.ts
- **Change**: Add handler
- **Verify**: src/__tests__/handler.test.ts:handlesRequest

### Task 2: Add error handler [pending]
- **File**: src/error.ts
- **Change**: Add error handler
- **Verify**: src/__tests__/error.test.ts:handlesError
`;

describe("taskCompleted: early returns", () => {
	it("returns silently when no task_subject", async () => {
		const taskCompleted = (await import("../task-completed.ts")).default;
		await taskCompleted({});
		expect(stdoutCapture.join("")).toBe("");
		expect(mockedSpawnSync).not.toHaveBeenCalled();
	});

	it("returns silently when no active plan", async () => {
		const taskCompleted = (await import("../task-completed.ts")).default;
		await taskCompleted({ task_subject: "Task 1: Add handler" });
		expect(stdoutCapture.join("")).toBe("");
		expect(mockedSpawnSync).not.toHaveBeenCalled();
	});

	it("returns silently when task has no verify field", async () => {
		writePlan(`## Tasks\n### Task 1: Add handler [pending]\n- **File**: src/handler.ts\n`);
		writeGates({ on_commit: { test: { command: "vitest run" } } });

		const taskCompleted = (await import("../task-completed.ts")).default;
		await taskCompleted({ task_subject: "Task 1: Add handler" });
		expect(stdoutCapture.join("")).toBe("");
		expect(mockedSpawnSync).not.toHaveBeenCalled();
	});

	it("returns silently when no test runner detected", async () => {
		writePlan(PLAN_WITH_VERIFY);
		// No gates → no test runner

		const taskCompleted = (await import("../task-completed.ts")).default;
		await taskCompleted({ task_subject: "Task 1: Add handler" });
		expect(stdoutCapture.join("")).toBe("");
		expect(mockedSpawnSync).not.toHaveBeenCalled();
	});
});

describe("taskCompleted: task matching", () => {
	it("matches by task number from subject", async () => {
		writePlan(PLAN_WITH_VERIFY);
		writeGates({ on_commit: { test: { command: "vitest run" } } });

		const taskCompleted = (await import("../task-completed.ts")).default;
		await taskCompleted({ task_subject: "Task 2: Add error handler" });

		// Verify spawnSync was called with the correct test file/name
		expect(mockedSpawnSync).toHaveBeenCalledOnce();
		const args = mockedSpawnSync.mock.calls[0]![1] as string[];
		expect(args).toContain("src/__tests__/error.test.ts");
		expect(args).toContain("handlesError");
	});

	it("does NOT match by substring (Add handler should not match Add error handler)", async () => {
		writePlan(PLAN_WITH_VERIFY);
		writeGates({ on_commit: { test: { command: "vitest run" } } });

		const taskCompleted = (await import("../task-completed.ts")).default;
		// Subject is just "Add handler" without task number — should match Task 1 exactly
		await taskCompleted({ task_subject: "Add handler" });

		// Verify spawnSync was called with Task 1's test, not Task 2's
		expect(mockedSpawnSync).toHaveBeenCalledOnce();
		const args = mockedSpawnSync.mock.calls[0]![1] as string[];
		expect(args).toContain("src/__tests__/handler.test.ts");
		expect(args).toContain("handlesRequest");
		expect(args).not.toContain("handlesError");
	});
});

describe("taskCompleted: verify execution", () => {
	it("runs verify test without error when test passes", async () => {
		writePlan(PLAN_WITH_VERIFY);
		writeGates({ on_commit: { test: { command: "vitest run" } } });

		const taskCompleted = (await import("../task-completed.ts")).default;
		await taskCompleted({ task_subject: "Task 1: Add handler" });

		expect(mockedSpawnSync).toHaveBeenCalledOnce();
		expect(mockedSpawnSync.mock.calls[0]![0]).toBe("vitest");
		const args = mockedSpawnSync.mock.calls[0]![1] as string[];
		expect(args).toContain("src/__tests__/handler.test.ts");
		expect(args).toContain("handlesRequest");

		// No stdout output — state is read via MCP
		expect(stdoutCapture.join("")).toBe("");
	});

	it("does not throw when test fails", async () => {
		writePlan(PLAN_WITH_VERIFY);
		writeGates({ on_commit: { test: { command: "vitest run" } } });

		mockedSpawnSync.mockImplementation(() => {
			const err = new Error("test failed") as Error & {
				stdout: string;
				stderr: string;
			};
			err.stdout = "FAIL handler.test.ts";
			err.stderr = "AssertionError";
			throw err;
		});

		const taskCompleted = (await import("../task-completed.ts")).default;
		// Should not throw — fail-open
		await taskCompleted({ task_subject: "Task 1: Add handler" });

		// No stdout output — state is read via MCP
		expect(stdoutCapture.join("")).toBe("");
	});
});

describe("taskCompleted: shell safety", () => {
	it("rejects verify field with shell metacharacters in file path", async () => {
		writePlan(`## Tasks
### Task 1: Exploit [pending]
- **File**: src/exploit.ts
- **Verify**: src/test.ts;rm+-rf+/:testName
`);
		writeGates({ on_commit: { test: { command: "vitest run" } } });

		const taskCompleted = (await import("../task-completed.ts")).default;
		await taskCompleted({ task_subject: "Task 1: Exploit" });

		expect(stdoutCapture.join("")).toBe("");
		expect(mockedSpawnSync).not.toHaveBeenCalled();
	});

	it("rejects test name with spaces", async () => {
		writePlan(`## Tasks
### Task 1: Test [pending]
- **File**: src/test.ts
- **Verify**: src/test.ts:test name with spaces
`);
		writeGates({ on_commit: { test: { command: "vitest run" } } });

		const taskCompleted = (await import("../task-completed.ts")).default;
		await taskCompleted({ task_subject: "Task 1: Test" });

		expect(stdoutCapture.join("")).toBe("");
		expect(mockedSpawnSync).not.toHaveBeenCalled();
	});
});

describe("taskCompleted: verify test quality check", () => {
	it("warns on shallow test file with too few assertions", async () => {
		writePlan(PLAN_WITH_VERIFY);
		writeGates({ on_commit: { test: { command: "vitest run" } } });

		// Create test file with only 1 assertion
		mkdirSync(join(TEST_DIR, "src", "__tests__"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, "src/__tests__/handler.test.ts"),
			`import { describe, it, expect } from "vitest";
describe("handler", () => {
  it("works", () => {
    expect(true).toBe(true);
  });
});`,
		);

		const taskCompleted = (await import("../task-completed.ts")).default;
		await taskCompleted({ task_subject: "Task 1: Add handler" });

		const stderr = stderrCapture.join("");
		expect(stderr).toContain("Test quality warning");
		expect(stderr).toContain("shallow tests");
	});

	it("does not warn on test file with sufficient assertions", async () => {
		writePlan(PLAN_WITH_VERIFY);
		writeGates({ on_commit: { test: { command: "vitest run" } } });

		mkdirSync(join(TEST_DIR, "src", "__tests__"), { recursive: true });
		writeFileSync(
			join(TEST_DIR, "src/__tests__/handler.test.ts"),
			`import { describe, it, expect } from "vitest";
describe("handler", () => {
  it("handles request", () => {
    expect(result.status).toBe(200);
    expect(result.body).toContain("ok");
    expect(result.headers).toHaveProperty("content-type");
  });
});`,
		);

		const taskCompleted = (await import("../task-completed.ts")).default;
		await taskCompleted({ task_subject: "Task 1: Add handler" });

		const stderr = stderrCapture.join("");
		expect(stderr).not.toContain("Test quality warning");
	});
});
