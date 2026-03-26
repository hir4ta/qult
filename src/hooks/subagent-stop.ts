import type { HookEvent } from "../types.ts";

/** SubagentStop: verify subagent completed properly */
export default async function subagentStop(ev: HookEvent): Promise<void> {
	// Prevent infinite loop
	if (ev.stop_hook_active) return;

	// For now: allow all subagent completions.
	// Future: read agent_transcript_path and verify output quality.
	// The key value is that this hook EXISTS and can be extended.
}
