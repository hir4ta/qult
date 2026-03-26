import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let stdoutCapture: string[] = [];
let stderrCapture: string[] = [];
let exitCode: number | null = null;

beforeEach(() => {
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
});

describe("configChange", () => {
	it("blocks changes to user_settings (protects hooks)", async () => {
		const handler = (await import("../config-change.ts")).default;
		try {
			await handler({
				hook_type: "ConfigChange",
				tool_input: { source: "user_settings" },
			});
		} catch {
			// exit(2)
		}

		expect(exitCode).toBe(2);
	});

	it("allows changes to project_settings", async () => {
		const handler = (await import("../config-change.ts")).default;
		await handler({
			hook_type: "ConfigChange",
			tool_input: { source: "project_settings" },
		});

		expect(exitCode).toBeNull();
	});

	it("allows changes to skills", async () => {
		const handler = (await import("../config-change.ts")).default;
		await handler({
			hook_type: "ConfigChange",
			tool_input: { source: "skills" },
		});

		expect(exitCode).toBeNull();
	});
});
