import { flushAll } from "../state/flush.ts";
import type { HookResponse } from "../types.ts";

/** Current hook event name, set by dispatcher before calling handler */
let _currentEvent = "unknown";
export function setCurrentEvent(event: string): void {
	_currentEvent = event;
}

/** Send additionalContext to Claude (advisory, non-blocking).
 * Only valid for: PostToolUse, SessionStart */
export function respond(context: string): void {
	const response: HookResponse = {
		hookSpecificOutput: {
			additionalContext: context,
		},
	};
	process.stdout.write(JSON.stringify(response));
}

/** DENY: block the action with a reason (exit 2). Always fires.
 * Only valid for: PreToolUse */
export function deny(reason: string): never {
	const response: HookResponse = {
		hookSpecificOutput: {
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	};
	try {
		flushAll();
	} catch {
		/* fail-open */
	}
	process.stdout.write(JSON.stringify(response));
	process.stderr.write(reason);
	process.exit(2);
}

/** Block Claude from stopping (exit 2). Always fires.
 * Uses top-level decision/reason per official schema.
 * Valid for: Stop, SubagentStop */
export function block(reason: string): never {
	const response: HookResponse = { decision: "block", reason };
	try {
		flushAll();
	} catch {
		/* fail-open */
	}
	process.stdout.write(JSON.stringify(response));
	process.stderr.write(reason);
	process.exit(2);
}
