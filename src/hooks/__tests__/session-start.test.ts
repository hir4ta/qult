import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeHandoff } from "../../state/handoff.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-session-test");
const STATE_DIR = join(TEST_DIR, ".alfred", ".state");
let stdoutCapture: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(STATE_DIR, { recursive: true });
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

function getResponse(): Record<string, unknown> | null {
	const output = stdoutCapture.join("");
	if (!output) return null;
	return JSON.parse(output);
}

describe("sessionStart hook", () => {
	it("injects handoff context when handoff exists", async () => {
		writeHandoff({
			summary: "Implementing auth middleware",
			changed_files: ["src/middleware.ts"],
			pending_fixes: false,
			next_steps: "Add tests for middleware",
			saved_at: new Date().toISOString(),
		});

		const handler = (await import("../session-start.ts")).default;
		await handler({ hook_type: "SessionStart" });

		const response = getResponse();
		expect(response).not.toBeNull();
		const context = (response?.hookSpecificOutput as Record<string, string>)?.additionalContext;
		expect(context).toContain("auth middleware");
		expect(context).toContain("Add tests");
	});

	it("creates .alfred dir if missing", async () => {
		rmSync(join(TEST_DIR, ".alfred"), { recursive: true, force: true });

		const handler = (await import("../session-start.ts")).default;
		await handler({ hook_type: "SessionStart" });

		const { existsSync } = await import("node:fs");
		expect(existsSync(join(TEST_DIR, ".alfred", ".state"))).toBe(true);
	});
});
