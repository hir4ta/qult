import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRY = join(import.meta.dirname, "..", "hook-entry.ts");

describe("hook-entry.ts", () => {
	it("exits 1 with usage message when no event argument is given", () => {
		const result = spawnSync("bun", ["run", ENTRY], {
			timeout: 5000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Usage: hook.mjs <event>");
	});

	it("exits 1 for unknown event with error on stderr", () => {
		const result = spawnSync("bun", ["run", ENTRY, "nonexistent"], {
			timeout: 5000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			input: JSON.stringify({}),
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Unknown hook event");
	});

	it("runs session-start handler with valid input (fail-open on no .qult/)", () => {
		const result = spawnSync("bun", ["run", ENTRY, "session-start"], {
			timeout: 5000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			input: JSON.stringify({ session_id: "entry-test" }),
			cwd: "/tmp",
		});
		// Should not crash — fail-open
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
	});
});
