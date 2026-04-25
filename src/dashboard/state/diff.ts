/**
 * Diff two snapshots and emit human-readable events describing the change.
 * Called by the watcher between successive snapshot collections.
 *
 * Pure function — accepts an EventStream-like sink to keep tests simple.
 */

import type { EventVariant } from "../types.ts";
import type { Snapshot } from "./snapshot.ts";

export interface EventSink {
	push(args: { kind: EventKindLike; variant: EventVariant; message: string }): void;
}

type EventKindLike =
	| "wave-complete"
	| "wave-start"
	| "test-pass"
	| "review"
	| "detector"
	| "spec-switch";

export function diffAndEmit(prev: Snapshot, next: Snapshot, sink: EventSink): void {
	// Spec switch.
	if (prev.activeSpec?.name !== next.activeSpec?.name) {
		sink.push({
			kind: "spec-switch",
			variant: "info",
			message: next.activeSpec
				? `Active spec → ${next.activeSpec.name} (${next.activeSpec.phase})`
				: "Active spec cleared",
		});
	}

	// Wave transitions: status change per wave number.
	const prevWaveByNum = new Map(prev.waves.map((w) => [w.number, w]));
	for (const cur of next.waves) {
		const before = prevWaveByNum.get(cur.number);
		if (!before || before.status === cur.status) continue;
		if (cur.status === "in-progress" && before.status === "todo") {
			sink.push({
				kind: "wave-start",
				variant: "info",
				message: `Wave ${cur.number} started — ${cur.title}`,
			});
		} else if (cur.status === "done") {
			sink.push({
				kind: "wave-complete",
				variant: "success",
				message: `Wave ${cur.number} completed — ${cur.title}`,
			});
		}
	}

	// Detector pendingFixes count change.
	const prevDet = new Map(prev.detectors.map((d) => [d.id, d]));
	for (const cur of next.detectors) {
		const before = prevDet.get(cur.id);
		if (!before) continue;
		if (before.pendingFixes !== cur.pendingFixes) {
			const delta = cur.pendingFixes - before.pendingFixes;
			sink.push({
				kind: "detector",
				variant: cur.pendingFixes > 0 ? "warning" : "success",
				message: `${cur.id}: pending fixes ${before.pendingFixes} → ${cur.pendingFixes} (${delta > 0 ? `+${delta}` : delta})`,
			});
		}
	}

	// Review stage transitions: passed flag change or new score.
	const stages: Array<keyof Snapshot["reviews"]> = ["spec", "quality", "security", "adversarial"];
	for (const key of stages) {
		const before = prev.reviews[key];
		const cur = next.reviews[key];
		if (before.score !== cur.score && cur.score !== null) {
			sink.push({
				kind: "review",
				variant: cur.passed ? "success" : "warning",
				message: `${capitalize(key)} review: ${cur.score}/20 (threshold ${cur.threshold}, ${cur.passed ? "pass" : "below"})`,
			});
		}
	}
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
