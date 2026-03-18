import { emitAdditionalContext } from "./dispatcher.js";
import type { HookEvent } from "./dispatcher.js";
import { isGateActive } from "./review-gate.js";
import {
	blockStop,
	countUncheckedNextSteps,
	hasUncheckedSelfReview,
	tryReadActiveSpec,
} from "./spec-guard.js";

/**
 * Stop handler:
 * - review-gate active → BLOCK (hard enforcement)
 * - unchecked Next Steps / self-review / incomplete spec → CONTEXT reminder (no block)
 * DEC-4: stop_hook_active=true → always allow (infinite loop prevention).
 */
export async function stop(ev: HookEvent): Promise<void> {
	// DEC-4: Prevent infinite loop — if Stop already triggered once, let Claude stop.
	if (ev.stop_hook_active) return;

	// Review gate check — BLOCKS stop when spec/wave review is pending.
	const gate = isGateActive(ev.cwd);
	if (gate) {
		const gateLabel =
			gate.gate === "wave-review" ? `Wave ${gate.wave ?? "?"} review` : "Spec self-review";
		blockStop(
			`${gateLabel} not completed for spec '${gate.slug}'. Run review, then: dossier action=gate sub_action=clear reason="<review summary>"`,
		);
		return;
	}

	// Everything below is CONTEXT only (no block). User can stop freely.
	const spec = tryReadActiveSpec(ev.cwd);
	if (!spec || spec.status === "completed") return;

	const reminders: string[] = [];

	const unchecked = countUncheckedNextSteps(ev.cwd, spec.slug);
	if (unchecked > 0) {
		reminders.push(`${unchecked} unchecked Next Steps in spec '${spec.slug}'`);
	}

	if (hasUncheckedSelfReview(ev.cwd, spec.slug)) {
		reminders.push("Self-review not completed");
	}

	reminders.push("When done, call `dossier action=complete` to close the spec");

	// Emit as CONTEXT (informational, non-blocking).
	emitAdditionalContext(
		"Stop",
		`[CONTEXT] Spec '${spec.slug}' reminders: ${reminders.join("; ")}`,
	);
}
