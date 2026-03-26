import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DIR = join(import.meta.dirname, ".tmp-subagent-stop-test");
let stdoutCapture: string[] = [];
let exitCode: number | null = null;
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(join(TEST_DIR, ".alfred", ".state"), { recursive: true });
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
});
