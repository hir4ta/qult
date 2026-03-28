import { flushAll } from "../state/flush.ts";
import { recordAction } from "../state/metrics.ts";
import {
	checkBudget,
	incrementActionCount,
	type PendingAdvisory,
	recordInjection,
	setPendingAdvisory,
} from "../state/session-state.ts";
import type { HookResponse } from "../types.ts";

/** Current hook event name, set by dispatcher before calling handler */
let _currentEvent = "unknown";
export function setCurrentEvent(event: string): void {
	_currentEvent = event;
}

/** Estimate tokens from string length (≈ 4 chars per token) */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Send additionalContext to Claude (advisory, non-blocking). Skipped if budget exceeded.
 * Only valid for: PostToolUse, SessionStart
 * @param advisory — optional advisory type for compliance tracking */
export function respond(context: string, advisory?: Omit<PendingAdvisory, "injected_at">): void {
	const tokens = estimateTokens(context);
	if (!checkBudget(tokens)) {
		try {
			recordAction(_currentEvent, "respond-skipped", context.slice(0, 100));
		} catch {
			/* fail-open */
		}
		return;
	}

	recordInjection(tokens);
	try {
		recordAction(_currentEvent, "respond", context.slice(0, 100));
		incrementActionCount("respond");
	} catch {
		/* fail-open */
	}
	if (advisory) {
		try {
			setPendingAdvisory({ ...advisory, injected_at: new Date().toISOString() });
		} catch {
			/* fail-open */
		}
	}
	const response: HookResponse = {
		hookSpecificOutput: {
			additionalContext: context,
		},
	};
	process.stdout.write(JSON.stringify(response));
}

/** DENY: block the action with a reason (exit 2). Always fires regardless of budget.
 * Only valid for: PreToolUse */
export function deny(reason: string): never {
	try {
		recordAction(_currentEvent, "deny", reason.slice(0, 100));
		incrementActionCount("deny");
	} catch {
		/* fail-open */
	}
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

/** Block Claude from stopping (exit 2). Always fires regardless of budget.
 * Uses top-level decision/reason per official schema.
 * Valid for: Stop */
export function block(reason: string): never {
	try {
		recordAction(_currentEvent, "block", reason.slice(0, 100));
		incrementActionCount("block");
	} catch {
		/* fail-open */
	}
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
