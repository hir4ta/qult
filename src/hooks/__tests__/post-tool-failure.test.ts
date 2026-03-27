import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCaches } from "../../state/flush.ts";
import { readSessionState } from "../../state/session-state.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-post-tool-failure-test");
let stdoutCapture: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	resetAllCaches();
	mkdirSync(join(TEST_DIR, ".qult", ".state"), { recursive: true });
	process.chdir(TEST_DIR);
	stdoutCapture = [];
	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	rmSync(TEST_DIR, { recursive: true, force: true });
});

function getContext(): string | undefined {
	const output = stdoutCapture.join("");
	if (!output) return undefined;
	return JSON.parse(output)?.hookSpecificOutput?.additionalContext;
}

describe("postToolUseFailure", () => {
	it("records failure and suggests /clear after 2 consecutive", async () => {
		const handler = (await import("../post-tool-failure.ts")).default;

		// First failure
		await handler({
			hook_type: "PostToolUseFailure",
			tool_name: "Bash",
			tool_input: { command: "npm test" },
			tool_output: "Error: test failed",
		});

		let state = readSessionState();
		expect(state.consecutive_error_count).toBe(1);

		// Second failure with same signature
		stdoutCapture = [];
		await handler({
			hook_type: "PostToolUseFailure",
			tool_name: "Bash",
			tool_input: { command: "npm test" },
			tool_output: "Error: test failed",
		});

		state = readSessionState();
		expect(state.consecutive_error_count).toBe(2);
		const context = getContext();
		expect(context).toContain("/clear");
	});

	it("resets count on different error", async () => {
		const handler = (await import("../post-tool-failure.ts")).default;

		await handler({
			hook_type: "PostToolUseFailure",
			tool_name: "Bash",
			tool_input: { command: "npm test" },
			tool_output: "Error: type A",
		});

		stdoutCapture = [];
		await handler({
			hook_type: "PostToolUseFailure",
			tool_name: "Bash",
			tool_input: { command: "npm test" },
			tool_output: "Error: type B",
		});

		const state = readSessionState();
		expect(state.consecutive_error_count).toBe(1); // reset because different error
	});
});
