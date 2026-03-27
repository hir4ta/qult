import type { HookEvent } from "../types.ts";
import { deny } from "./respond.ts";

/** ConfigChange: protect hook settings from modification (prevents hook removal) */
export default async function configChange(ev: HookEvent): Promise<void> {
	const source = ev.tool_input?.source;
	if (source !== "user_settings") return;

	// Only block changes that target hooks (where qult hooks are registered)
	const content = typeof ev.tool_input?.content === "string" ? ev.tool_input.content : "";
	const key = typeof ev.tool_input?.key === "string" ? ev.tool_input.key : "";

	if (key === "hooks" || key.startsWith("hooks.") || content.includes('"hooks"')) {
		deny(
			"Cannot modify hook settings — qult hooks are registered there. Use 'qult init --force' to reconfigure.",
		);
	}

	// Allow other user_settings changes (theme, model, permissions, etc.)
}
