/**
 * Shared Agent Skills SKILL.md builder.
 *
 * Used by all 4 integrations to produce a frontmatter-bearing SKILL.md from a
 * markdown body + skill name. Centralizes the per-command description map so
 * Claude / Cursor / Codex / Gemini all surface the same auto-invoke metadata.
 *
 * The bundled `templates/bundled/commands/<name>.md` files are agent-neutral
 * (no frontmatter); this helper attaches the frontmatter at write time.
 */

const DESCRIPTIONS: Record<string, string> = {
	spec: "Start a new SDD spec under .qult/specs/<name>/. Runs requirements → clarify → design → tasks with a quality gate at each phase. Use when starting any non-trivial feature.",
	"wave-start":
		"Begin the next incomplete Wave on the active spec. Records the start commit SHA into waves/wave-NN.md so /qult:wave-complete can compute the commit range.",
	"wave-complete":
		"Finalize the current Wave: verify range integrity, run tests, run detectors, generate a [wave-NN] conventional commit, and persist Range/completed_at to waves/wave-NN.md.",
	review:
		"Run an independent 4-stage code review (Spec compliance → Code quality → Security → Adversarial) before a major commit or as a review gate. NOT for trivial changes.",
	finish:
		"Branch completion workflow. Use when implementation is complete and all tests pass — guides through merge, PR, hold, or discard. NOT for incomplete work.",
};

/** One-line description for a qult command name (e.g. "spec"). */
export function descriptionFor(name: string): string {
	return DESCRIPTIONS[name] ?? `qult ${name} workflow command`;
}

/** Build an Agent Skills `SKILL.md` (frontmatter + body) for a qult command. */
export function buildSkillFile(name: string, body: string): string {
	return `---
name: qult-${name}
description: ${descriptionFor(name)}
---

${body.trimStart()}`;
}
