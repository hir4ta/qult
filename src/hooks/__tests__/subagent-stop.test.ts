import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-subagent-stop-test");
let stdoutCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(join(TEST_DIR, ".qult", ".state"), { recursive: true });
	process.chdir(TEST_DIR);
	stdoutCapture = [];
	exitCode = null;
	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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

describe("subagentStop", () => {
	it("allows normal subagent completion", async () => {
		const handler = (await import("../subagent-stop.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			stop_hook_active: false,
		});
		expect(exitCode).toBeNull();
	});

	it("does not block when stop_hook_active is true", async () => {
		const handler = (await import("../subagent-stop.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			stop_hook_active: true,
		});
		expect(exitCode).toBeNull();
	});

	it("allows unknown agent_type (fail-open)", async () => {
		const handler = (await import("../subagent-stop.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "Explore",
			last_assistant_message: "some output",
		});
		expect(exitCode).toBeNull();
	});

	it("allows when last_assistant_message is missing (fail-open)", async () => {
		const handler = (await import("../subagent-stop.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "qult-reviewer",
		});
		expect(exitCode).toBeNull();
	});

	it("blocks qult-reviewer without findings", async () => {
		const handler = (await import("../subagent-stop.ts")).default;
		try {
			await handler({
				hook_type: "SubagentStop",
				agent_type: "qult-reviewer",
				last_assistant_message: "I looked at the code and it seems fine.",
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);
	});

	it("allows qult-reviewer with severity findings", async () => {
		const handler = (await import("../subagent-stop.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "qult-reviewer",
			last_assistant_message:
				"- [high] src/foo.ts:42 — missing null check\n  Fix: add if (!x) return;",
		});
		expect(exitCode).toBeNull();
	});

	it("allows qult-reviewer with 'No issues found'", async () => {
		const handler = (await import("../subagent-stop.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "qult-reviewer",
			last_assistant_message: "No issues found from correctness perspective.",
		});
		expect(exitCode).toBeNull();
	});

	it("allows qult-reviewer with PASS verdict + Score line", async () => {
		const handler = (await import("../subagent-stop.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "qult-reviewer",
			last_assistant_message:
				"Review: PASS\nScore: Correctness=5 Design=4 Security=5\n\nNo major issues.",
		});
		expect(exitCode).toBeNull();
	});

	it("blocks qult-reviewer with FAIL verdict (requires fix + re-review)", async () => {
		const handler = (await import("../subagent-stop.ts")).default;
		try {
			await handler({
				hook_type: "SubagentStop",
				agent_type: "qult-reviewer",
				last_assistant_message:
					"Review: FAIL\nScore: Correctness=2 Design=3 Security=4\n\n- [critical] src/foo.ts:10 — SQL injection\n  Fix: use parameterized query",
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);
		const output = stdoutCapture.join("");
		expect(output).toContain("FAIL");
	});

	it("blocks qult-reviewer with PASS verdict but no Score or findings", async () => {
		const handler = (await import("../subagent-stop.ts")).default;
		try {
			await handler({
				hook_type: "SubagentStop",
				agent_type: "qult-reviewer",
				last_assistant_message: "Review: PASS\n\nThe code looks good overall.",
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);
	});

	it("blocks Plan agent when plan file lacks required sections", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(join(planDir, "bad-plan.md"), "## Context\n- Do stuff\n- Do more stuff");

		const handler = (await import("../subagent-stop.ts")).default;
		try {
			await handler({
				hook_type: "SubagentStop",
				agent_type: "Plan",
				last_assistant_message: "I created a plan.",
			});
		} catch {
			// process.exit(2)
		}
		expect(exitCode).toBe(2);
	});

	it("allows Plan agent when plan file has Tasks section", async () => {
		const planDir = join(TEST_DIR, ".claude", "plans");
		mkdirSync(planDir, { recursive: true });
		writeFileSync(
			join(planDir, "good-plan.md"),
			"## Context\nAdding auth\n\n## Tasks\n### Task 1: Add middleware [pending]",
		);

		const handler = (await import("../subagent-stop.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "Plan",
			last_assistant_message: "I created a plan with tasks and review gates.",
		});
		expect(exitCode).toBeNull();
	});

	it("allows Plan agent when no plan file exists (fail-open)", async () => {
		const handler = (await import("../subagent-stop.ts")).default;
		await handler({
			hook_type: "SubagentStop",
			agent_type: "Plan",
			last_assistant_message: "I created a plan.",
		});
		expect(exitCode).toBeNull();
	});
});
