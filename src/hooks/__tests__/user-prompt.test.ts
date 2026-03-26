import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookEvent } from "../../types.ts";

let stdoutCapture: string[] = [];

beforeEach(() => {
	stdoutCapture = [];
	vi.spyOn(process.stdout, "write").mockImplementation((data) => {
		stdoutCapture.push(typeof data === "string" ? data : data.toString());
		return true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function getResponse(): Record<string, unknown> | null {
	const output = stdoutCapture.join("");
	if (!output) return null;
	return JSON.parse(output);
}

describe("userPrompt", () => {
	it("injects plan template when permission_mode is plan", async () => {
		const handler = (await import("../user-prompt.ts")).default;

		await handler({
			hook_type: "UserPromptSubmit",
			permission_mode: "plan",
			prompt: "implement a new feature",
		});

		const response = getResponse();
		expect(response).not.toBeNull();

		const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
		expect(context).toBeDefined();
		// Template should contain key sections
		expect(context).toContain("Task");
		expect(context).toContain("Review");
	});

	it("does not inject template in normal mode", async () => {
		const handler = (await import("../user-prompt.ts")).default;

		await handler({
			hook_type: "UserPromptSubmit",
			prompt: "fix a typo",
		});

		const response = getResponse();
		// No output or no plan template
		if (response) {
			const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
			expect(context ?? "").not.toContain("## Tasks");
		}
	});

	it("suggests plan mode for large tasks in normal mode", async () => {
		const handler = (await import("../user-prompt.ts")).default;

		// Long prompt with multiple files mentioned
		const longPrompt =
			"implement authentication with JWT tokens, add login endpoint, signup endpoint, " +
			"middleware for protected routes, update user model, add password hashing, " +
			"create refresh token logic, update the database schema, add tests for all endpoints";

		await handler({
			hook_type: "UserPromptSubmit",
			prompt: longPrompt,
		});

		const response = getResponse();
		if (response) {
			const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
			if (context) {
				expect(context.toLowerCase()).toContain("plan");
			}
		}
	});
});
