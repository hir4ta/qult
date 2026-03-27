import { describe, expect, it } from "vitest";
import {
	parseCriteriaCommands,
	parseFileFields,
	parsePlanTasks,
	parseVerifyFields,
} from "../plan-status.ts";

describe("parsePlanTasks", () => {
	it("parses tasks with status markers", () => {
		const plan = `## Context
Adding auth feature

## Tasks
### Task 1: Add middleware [done]
- File: src/middleware.ts
- Verify: src/__tests__/middleware.test.ts

### Task 2: Add routes [pending]
- File: src/routes.ts
- Verify: src/__tests__/routes.test.ts

### Task 3: Update config [in-progress]
- File: src/config.ts
- Verify: src/__tests__/config.test.ts

## Review Gates
- [x] Design Review
- [ ] Final Review`;

		const tasks = parsePlanTasks(plan);
		expect(tasks).toHaveLength(5); // 3 tasks + 2 review gates
		expect(tasks[0]).toEqual({ name: "Add middleware", status: "done" });
		expect(tasks[1]).toEqual({ name: "Add routes", status: "pending" });
		expect(tasks[2]).toEqual({ name: "Update config", status: "in-progress" });
		// Review gates
		expect(tasks[3]).toEqual({ name: "Design Review", status: "done" });
		expect(tasks[4]).toEqual({ name: "Final Review", status: "pending" });
	});

	it("defaults to pending when no status marker", () => {
		const plan = `## Tasks
### Task 1: Add helper
- File: src/helper.ts`;

		const tasks = parsePlanTasks(plan);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toEqual({ name: "Add helper", status: "pending" });
	});

	it("returns empty for plan without tasks", () => {
		const plan = `## Context
Just a note`;

		const tasks = parsePlanTasks(plan);
		expect(tasks).toHaveLength(0);
	});

	it("parses review gates as checkboxes", () => {
		const plan = `## Review Gates
- [x] Design Review
- [ ] Phase Review
- [x] Final Review`;

		const tasks = parsePlanTasks(plan);
		// Review gates should also be tracked
		expect(tasks).toHaveLength(3);
		expect(tasks[0]).toEqual({ name: "Design Review", status: "done" });
		expect(tasks[1]).toEqual({ name: "Phase Review", status: "pending" });
		expect(tasks[2]).toEqual({ name: "Final Review", status: "done" });
	});

	it("handles mixed task and review gate formats", () => {
		const plan = `## Tasks
### Task 1: Implement feature [done]
- File: src/feature.ts

### Task 2: Write tests [pending]
- File: src/__tests__/feature.test.ts

## Review Gates
- [x] Design Review
- [ ] Final Review`;

		const tasks = parsePlanTasks(plan);
		expect(tasks).toHaveLength(4);

		const pending = tasks.filter((t) => t.status === "pending");
		expect(pending).toHaveLength(2);
		expect(pending.map((t) => t.name)).toContain("Write tests");
		expect(pending.map((t) => t.name)).toContain("Final Review");
	});
});

describe("parseVerifyFields", () => {
	it("extracts Verify fields with task names", () => {
		const plan = `## Tasks
### Task 1: Add middleware [pending]
- **File**: src/middleware.ts
- **Verify**: src/__tests__/middleware.test.ts:authMiddleware

### Task 2: Add routes [pending]
- **File**: src/routes.ts
- **Verify**: src/__tests__/routes.test.ts:handleLogin`;

		const verifies = parseVerifyFields(plan);
		expect(verifies).toHaveLength(2);
		expect(verifies[0]).toEqual({
			taskName: "Add middleware",
			testFile: "src/__tests__/middleware.test.ts",
			testFunction: "authMiddleware",
		});
		expect(verifies[1]).toEqual({
			taskName: "Add routes",
			testFile: "src/__tests__/routes.test.ts",
			testFunction: "handleLogin",
		});
	});

	it("handles Verify without function name", () => {
		const plan = `## Tasks
### Task 1: Add helper [pending]
- **Verify**: src/__tests__/helper.test.ts`;

		const verifies = parseVerifyFields(plan);
		expect(verifies).toHaveLength(1);
		expect(verifies[0]!.testFunction).toBeNull();
	});

	it("returns empty for plan without Verify fields", () => {
		const plan = `## Tasks
### Task 1: Add helper [pending]
- **File**: src/helper.ts`;

		const verifies = parseVerifyFields(plan);
		expect(verifies).toHaveLength(0);
	});
});

describe("parseFileFields", () => {
	it("extracts File fields with task names", () => {
		const plan = `## Tasks
### Task 1: Add auth [pending]
- **File**: src/auth.ts
- **Verify**: src/__tests__/auth.test.ts:testLogin

### Task 2: Add routes [pending]
- **File**: src/routes.ts`;

		const files = parseFileFields(plan);
		expect(files).toHaveLength(2);
		expect(files[0]).toEqual({ taskName: "Add auth", filePath: "src/auth.ts" });
		expect(files[1]).toEqual({ taskName: "Add routes", filePath: "src/routes.ts" });
	});

	it("returns empty for plan without File fields", () => {
		expect(parseFileFields("## Tasks\n### Task 1: Fix\n")).toHaveLength(0);
	});
});

describe("parseCriteriaCommands", () => {
	it("extracts backtick commands from Success Criteria", () => {
		const plan = `## Tasks
### Task 1: Feature [done]
## Success Criteria
- [ ] \`bun vitest run\` — all tests pass
- [ ] \`bun tsc --noEmit\` — no type errors
- [ ] Manual review complete`;

		const commands = parseCriteriaCommands(plan);
		expect(commands).toEqual(["bun vitest run", "bun tsc --noEmit"]);
	});

	it("returns empty when no Success Criteria section", () => {
		expect(parseCriteriaCommands("## Tasks\n### Task 1: Fix\n")).toHaveLength(0);
	});

	it("stops at next ## heading", () => {
		const plan = `## Success Criteria
- [ ] \`bun test\` passes
## Notes
Some \`code here\` that should not be parsed`;

		const commands = parseCriteriaCommands(plan);
		expect(commands).toEqual(["bun test"]);
	});
});
