import type { HookEvent, HookResponse } from "../types.ts";

const LARGE_TASK_THRESHOLD = 200; // chars — prompt length heuristic

const PLAN_TEMPLATE = `Structure your plan as follows:

## Context
Why this change is needed — problem, trigger, intended outcome.

## Tasks
Each task MUST:
- Change only 1 file
- Be under 15 lines of diff
- Specify a verification test (file:function)

### Task N: <name>
- **File**: <path>
- **Change**: <what to do, behavior-focused>
- **Verify**: <test file : test function>
- **Boundary**: <what NOT to do>

## Review Gates
- [ ] Design Review: before starting implementation, run /alfred:review on this plan
- [ ] Phase Review: after every 3 tasks, run /alfred:review on the diff
- [ ] Final Review: after all tasks, run /alfred:review on all changes`;

/** UserPromptSubmit: Plan template injection + large task detection */
export default async function userPrompt(ev: HookEvent): Promise<void> {
	const prompt = typeof ev.prompt === "string" ? ev.prompt : "";

	if (ev.permission_mode === "plan") {
		respond(PLAN_TEMPLATE);
		return;
	}

	// Normal mode: suggest plan for large tasks
	if (prompt.length > LARGE_TASK_THRESHOLD) {
		respond(
			"This looks like a large task. Consider using Plan mode (Shift+Tab twice) to break it into small, verified tasks before implementing.",
		);
	}
}

function respond(context: string): void {
	const response: HookResponse = {
		hookSpecificOutput: {
			additionalContext: context,
		},
	};
	process.stdout.write(JSON.stringify(response));
}
