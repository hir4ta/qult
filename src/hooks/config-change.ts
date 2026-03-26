import type { HookEvent } from "../types.ts";
import { deny } from "./respond.ts";

/** ConfigChange: protect user_settings from modification (prevents hook removal) */
export default async function configChange(ev: HookEvent): Promise<void> {
	const source = ev.tool_input?.source;

	// Block changes to user settings (where alfred hooks live)
	if (source === "user_settings") {
		deny(
			"Cannot modify user settings directly — alfred hooks are registered there. Use 'alfred init --force' to reconfigure.",
		);
	}

	// Allow project_settings, local_settings, skills, etc.
}
