import type { HookEvent } from "./dispatcher.js";
import { isGateActive } from "./review-gate.js";
import { blockStop } from "./spec-guard.js";

/**
 * Stop handler:
 * - review-gate active → BLOCK (hard enforcement)
 * - All soft reminders (unchecked tasks, self-review, completion) moved to rules.
 * DEC-4: stop_hook_active=true → always allow (infinite loop prevention).
 */
export async function stop(ev: HookEvent): Promise<void> {
	if (ev.stop_hook_active) return;

	// Review gate check — BLOCKS stop when spec/wave review is pending.
	const gate = isGateActive(ev.cwd);
	if (gate) {
		const gateLabel =
			gate.gate === "wave-review" ? `Wave ${gate.wave ?? "?"} review` : "Spec self-review";
		blockStop(
			`${gateLabel} not completed for spec '${gate.slug}'. Run review, then: dossier action=gate sub_action=clear reason="<review summary>"`,
		);
	}
}
