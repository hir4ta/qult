/**
 * Non-TTY fallback: emit a single human-readable snapshot of the current
 * dashboard state to stdout, then return. Used when stdout isn't a TTY
 * (CI, pipe, redirect) so `qult dashboard | cat` produces something useful
 * instead of the raw Ink ANSI stream.
 */

import { collectSnapshot } from "./state/snapshot.ts";

export function printPlainSnapshot(out: NodeJS.WriteStream = process.stdout): void {
	const snapshot = collectSnapshot({ startedAt: Date.now(), now: Date.now() });
	const lines: string[] = [];
	lines.push(`qult dashboard ${snapshot.qultVersion} — non-TTY snapshot`);
	if (!snapshot.activeSpec) {
		lines.push("  active spec: <none>");
	} else {
		lines.push(`  active spec: ${snapshot.activeSpec.name} (${snapshot.activeSpec.phase})`);
	}
	lines.push(
		`  waves: ${snapshot.waves.length} (${snapshot.waves.filter((w) => w.status === "done").length} done)`,
	);
	const totalFixes = snapshot.detectors.reduce((acc, d) => acc + d.pendingFixes, 0);
	lines.push(`  detectors: 5 tracked, ${totalFixes} pending fixes`);
	const reviewKeys = ["spec", "quality", "security", "adversarial"] as const;
	const reviewLine = reviewKeys
		.map((k) => {
			const r = snapshot.reviews[k];
			return r.score === null ? `${k}=—` : `${k}=${r.score}/${r.threshold}`;
		})
		.join(" ");
	lines.push(`  reviews: ${reviewLine}`);
	out.write(`${lines.join("\n")}\n`);
}
