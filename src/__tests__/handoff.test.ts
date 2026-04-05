import { describe, expect, it } from "vitest";
import { generateHandoffDocument } from "../handoff.ts";
import type { PlanTask } from "../state/plan-status.ts";
import type { PendingFix } from "../types.ts";

describe("generateHandoffDocument", () => {
	it("returns no-session message when no state exists", () => {
		const result = generateHandoffDocument({
			changedFiles: [],
			pendingFixes: [],
			planTasks: null,
			testPassed: false,
			reviewDone: false,
			disabledGates: [],
		});
		expect(result).toContain("No active session");
	});

	it("includes changed files list", () => {
		const result = generateHandoffDocument({
			changedFiles: ["src/foo.ts", "src/bar.ts"],
			pendingFixes: [],
			planTasks: null,
			testPassed: true,
			reviewDone: false,
			disabledGates: [],
		});
		expect(result).toContain("src/foo.ts");
		expect(result).toContain("src/bar.ts");
		expect(result).toContain("Files Changed");
	});

	it("includes pending fixes when present", () => {
		const fixes: PendingFix[] = [
			{ file: "src/broken.ts", errors: ["TS2322: Type error"], gate: "typecheck" },
		];
		const result = generateHandoffDocument({
			changedFiles: ["src/broken.ts"],
			pendingFixes: fixes,
			planTasks: null,
			testPassed: false,
			reviewDone: false,
			disabledGates: [],
		});
		expect(result).toContain("Pending Fixes");
		expect(result).toContain("src/broken.ts");
		expect(result).toContain("typecheck");
	});

	it("includes plan progress when plan is active", () => {
		const tasks: PlanTask[] = [
			{ name: "Add feature", status: "done", taskNumber: 1 },
			{ name: "Write tests", status: "pending", taskNumber: 2 },
			{ name: "Update docs", status: "pending", taskNumber: 3 },
		];
		const result = generateHandoffDocument({
			changedFiles: ["src/feature.ts"],
			pendingFixes: [],
			planTasks: tasks,
			testPassed: true,
			reviewDone: false,
			disabledGates: [],
		});
		expect(result).toContain("Plan Progress");
		expect(result).toContain("1/3 done");
		expect(result).toContain("[done] Task 1: Add feature");
		expect(result).toContain("[pending] Task 2: Write tests");
	});

	it("includes gate status summary", () => {
		const result = generateHandoffDocument({
			changedFiles: ["src/foo.ts"],
			pendingFixes: [],
			planTasks: null,
			testPassed: true,
			reviewDone: true,
			disabledGates: ["lint"],
		});
		expect(result).toContain("Tests: PASSED");
		expect(result).toContain("Review: DONE");
		expect(result).toContain("lint");
	});

	it("shows all sections in a complete handoff", () => {
		const result = generateHandoffDocument({
			changedFiles: ["src/a.ts", "src/b.ts"],
			pendingFixes: [{ file: "src/a.ts", errors: ["error"], gate: "lint" }],
			planTasks: [
				{ name: "Task A", status: "done", taskNumber: 1 },
				{ name: "Task B", status: "in-progress", taskNumber: 2 },
			],
			testPassed: false,
			reviewDone: false,
			disabledGates: [],
		});
		expect(result).toContain("## Session Handoff");
		expect(result).toContain("## Gate Status");
		expect(result).toContain("## Files Changed");
		expect(result).toContain("## Pending Fixes");
		expect(result).toContain("## Plan Progress");
	});
});
