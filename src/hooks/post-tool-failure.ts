import { recordFailure } from "../state/fail-count.ts";
import type { HookEvent } from "../types.ts";
import { respond } from "./respond.ts";

/** PostToolUseFailure: track tool crashes/timeouts, suggest /clear after 2 consecutive */
export default async function postToolFailure(ev: HookEvent): Promise<void> {
	const error = typeof ev.tool_output === "string" ? ev.tool_output : "";
	const toolName = ev.tool_name ?? "unknown";

	// Build a signature from tool + error for deduplication
	const signature = `${toolName}:${error.slice(0, 200)}`;
	const count = recordFailure(signature);

	if (count >= 2) {
		respond(
			`Tool "${toolName}" has failed ${count} times with the same error. Consider running /clear and trying a different approach.`,
		);
	}
}
