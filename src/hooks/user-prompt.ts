import type { HookEvent } from "../types.ts";
import { respond } from "./respond.ts";

const SHORT_THRESHOLD = 200;
const FULL_TEMPLATE_THRESHOLD = 500;

const COMPACT_TEMPLATE = `Structure your plan:

## Context
Why this change is needed.

## Tasks
Each task: focused (1-2 files, ≤15 LOC change). Split larger work into more tasks.

### Task N: <name> [pending]
- **File**: <path>
- **Change**: <what to do>
- **Boundary**: <what NOT to change>
- **Verify**: <test file : test function>

## Success Criteria
Concrete, testable conditions that define "done" for this plan.
- [ ] \`<specific command>\` — expected outcome

Update status to [done] as you complete each task.`;

const FULL_TEMPLATE = `${COMPACT_TEMPLATE}

Note: Independent review (/qult:review) is automatically required before each commit. You don't need to plan for it — it's enforced by the harness.`;

/** UserPromptSubmit: Plan template injection (plan mode only).
 * Non-plan advisory removed — Opus 4.6 handles task scoping autonomously. */
export default async function userPrompt(ev: HookEvent): Promise<void> {
	if (ev.permission_mode !== "plan") return;

	const prompt = typeof ev.prompt === "string" ? ev.prompt : "";
	if (prompt.length < SHORT_THRESHOLD) return;

	if (prompt.length >= FULL_TEMPLATE_THRESHOLD) {
		respond(FULL_TEMPLATE);
	} else {
		respond(COMPACT_TEMPLATE);
	}
}
