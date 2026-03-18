import type { HookEvent } from "./dispatcher.js";
import { isGateActive } from "./review-gate.js";
import {
	blockStop,
	countUncheckedNextSteps,
	hasUncheckedSelfReview,
	tryReadActiveSpec,
} from "./spec-guard.js";
import { readWorkedSlugs } from "./state.js";

/**
 * Stop handler:
 * - review-gate active → BLOCK (hard enforcement)
 * - unchecked Next Steps / self-review / incomplete spec → CONTEXT reminder (no block)
 * - Session-scoped: only reminds about specs worked on in this session (via worked-slugs).
 *   Fallback: if no worked-slugs recorded (read-only session), uses current primary.
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

	// Session-scoped: only remind about the *primary* spec if it was actually worked on.
	// We only check the primary spec (not all worked slugs) because tryReadActiveSpec
	// reads session.md of the primary only. Fallback: if no worked-slugs recorded
	// (read-only / Bash-only session), show reminders for primary as before.
	const workedSlugs = ev.cwd ? readWorkedSlugs(ev.cwd) : [];
	if (workedSlugs.length > 0 && !workedSlugs.includes(spec.slug)) {
		return;
	}

	const reminders: string[] = [];

	const unchecked = countUncheckedNextSteps(ev.cwd, spec.slug);
	if (unchecked > 0) {
		reminders.push(`${unchecked} unchecked Next Steps in spec '${spec.slug}'`);
	}

	if (hasUncheckedSelfReview(ev.cwd, spec.slug)) {
		reminders.push("Self-review not completed");
	}

	reminders.push("When done, call `dossier action=complete` to close the spec");

	// Emit as systemMessage (Stop hooks don't support hookSpecificOutput).
	const msg = `[CONTEXT] Spec '${spec.slug}' reminders: ${reminders.join("; ")}`;
	process.stdout.write(`${JSON.stringify({ systemMessage: msg })}\n`);
}
