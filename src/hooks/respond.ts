import type { HookResponse } from "../types.ts";

/** Send additionalContext to Claude (advisory, non-blocking) */
export function respond(context: string): void {
	const response: HookResponse = {
		hookSpecificOutput: {
			additionalContext: context,
		},
	};
	process.stdout.write(JSON.stringify(response));
}

/** DENY: block the action with a reason (exit 2) */
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

/** Block Claude from stopping (exit 2) */
export function block(reason: string): never {
	const response: HookResponse = {
		hookSpecificOutput: {
			decision: "block",
			reason,
		},
	};
	process.stdout.write(JSON.stringify(response));
	process.stderr.write(reason);
	process.exit(2);
}
