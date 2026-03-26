import { checkBudget, recordInjection } from "../state/context-budget.ts";
import type { HookResponse } from "../types.ts";

/** Estimate tokens from string length (≈ 4 chars per token) */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Send additionalContext to Claude (advisory, non-blocking). Skipped if budget exceeded. */
export function respond(context: string): void {
	const tokens = estimateTokens(context);
	if (!checkBudget(tokens)) return; // budget exceeded → skip (fail-open)

	recordInjection(tokens);
	const response: HookResponse = {
		hookSpecificOutput: {
			additionalContext: context,
		},
	};
	process.stdout.write(JSON.stringify(response));
}

/** DENY: block the action with a reason (exit 2). Always fires regardless of budget. */
export function deny(reason: string): never {
	const response: HookResponse = {
		hookSpecificOutput: {
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	};
	process.stdout.write(JSON.stringify(response));
	process.stderr.write(reason);
	process.exit(2);
}

/** Block Claude from stopping (exit 2). Always fires regardless of budget. */
export function block(reason: string): never {
	const response = { decision: "block", reason };
	process.stdout.write(JSON.stringify(response));
	process.stderr.write(reason);
	process.exit(2);
}
