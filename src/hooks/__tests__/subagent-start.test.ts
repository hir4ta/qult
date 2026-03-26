import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePendingFixes } from "../../state/pending-fixes.ts";

const TEST_DIR = join(import.meta.dirname, ".tmp-subagent-start-test");
let stdoutCapture: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	mkdirSync(join(TEST_DIR, ".alfred", ".state"), { recursive: true });
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
	const response = JSON.parse(output);
	return response?.hookSpecificOutput?.additionalContext;
}

describe("subagentStart", () => {
	it("injects quality rules into subagent context", async () => {
		const handler = (await import("../subagent-start.ts")).default;
		await handler({ hook_type: "SubagentStart" });

		const context = getContext();
		expect(context).toBeDefined();
		expect(context).toContain("task");
		expect(context).toContain("15");
	});

	it("injects pending-fixes warning when fixes exist", async () => {
		writePendingFixes([{ file: "src/foo.ts", errors: ["lint error"], gate: "lint" }]);

		const handler = (await import("../subagent-start.ts")).default;
		await handler({ hook_type: "SubagentStart" });

		const context = getContext();
		expect(context).toBeDefined();
		expect(context).toContain("pending");
		expect(context).toContain("foo.ts");
	});

	it("injects conventions from rules file if exists", async () => {
		const rulesDir = join(TEST_DIR, ".claude", "rules");
		mkdirSync(rulesDir, { recursive: true });
		writeFileSync(
			join(rulesDir, "alfred-quality.md"),
			"- Always write tests first\n- Max 15 LOC per task",
		);

		const handler = (await import("../subagent-start.ts")).default;
		await handler({ hook_type: "SubagentStart" });

		const context = getContext();
		expect(context).toBeDefined();
		expect(context).toContain("tests first");
	});
});
