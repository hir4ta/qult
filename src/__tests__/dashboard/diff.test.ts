import { describe, expect, it } from "vitest";
import { diffAndEmit, type EventSink } from "../../dashboard/state/diff.ts";
import type { Snapshot } from "../../dashboard/state/snapshot.ts";
import { ALL_DETECTOR_IDS, REVIEW_THRESHOLD_DEFAULT } from "../../dashboard/types.ts";

function emptyReviews(): Snapshot["reviews"] {
	const e = { score: null, threshold: REVIEW_THRESHOLD_DEFAULT, passed: null };
	return { spec: { ...e }, quality: { ...e }, security: { ...e }, adversarial: { ...e } };
}

function freshSnapshot(): Snapshot {
	return {
		qultVersion: "0.0.0-test",
		startedAt: 0,
		now: 0,
		activeSpec: null,
		waves: [],
		detectors: ALL_DETECTOR_IDS.map((id) => ({
			id,
			status: "never-run" as const,
			pendingFixes: 0,
			filesScanned: null,
			lastRunAt: null,
		})),
		reviews: emptyReviews(),
	};
}

function recordingSink(): { sink: EventSink; events: Array<{ kind: string; message: string }> } {
	const events: Array<{ kind: string; message: string }> = [];
	return {
		events,
		sink: { push: (e) => events.push({ kind: e.kind, message: e.message }) },
	};
}

describe("diffAndEmit", () => {
	it("emits spec-switch when active spec changes", () => {
		const prev = freshSnapshot();
		const next: Snapshot = { ...prev, activeSpec: { name: "x", phase: "tasks" } };
		const { sink, events } = recordingSink();
		diffAndEmit(prev, next, sink);
		expect(events.some((e) => e.kind === "spec-switch")).toBe(true);
	});

	it("emits wave-start when status flips todo → in-progress", () => {
		const wave = {
			number: 1,
			title: "t",
			tasksDone: 0,
			tasksTotal: 5,
			startedAt: null,
			completedAt: null,
		};
		const prev: Snapshot = { ...freshSnapshot(), waves: [{ ...wave, status: "todo" }] };
		const next: Snapshot = { ...freshSnapshot(), waves: [{ ...wave, status: "in-progress" }] };
		const { sink, events } = recordingSink();
		diffAndEmit(prev, next, sink);
		expect(events.find((e) => e.kind === "wave-start")?.message).toContain("Wave 1");
	});

	it("emits wave-complete when status flips to done", () => {
		const wave = {
			number: 2,
			title: "x",
			tasksDone: 5,
			tasksTotal: 5,
			startedAt: null,
			completedAt: null,
		};
		const prev: Snapshot = { ...freshSnapshot(), waves: [{ ...wave, status: "in-progress" }] };
		const next: Snapshot = { ...freshSnapshot(), waves: [{ ...wave, status: "done" }] };
		const { sink, events } = recordingSink();
		diffAndEmit(prev, next, sink);
		expect(events.find((e) => e.kind === "wave-complete")?.message).toContain("Wave 2");
	});

	it("emits detector event when pending fixes count changes", () => {
		const prev = freshSnapshot();
		const next: Snapshot = {
			...prev,
			detectors: prev.detectors.map((d) =>
				d.id === "security" ? { ...d, pendingFixes: 3, status: "fail" } : d,
			),
		};
		const { sink, events } = recordingSink();
		diffAndEmit(prev, next, sink);
		const ev = events.find((e) => e.kind === "detector");
		expect(ev?.message).toContain("security");
		expect(ev?.message).toContain("+3");
	});

	it("emits review event when score is set", () => {
		const prev = freshSnapshot();
		const next: Snapshot = {
			...prev,
			reviews: {
				...prev.reviews,
				security: { score: 18, threshold: REVIEW_THRESHOLD_DEFAULT, passed: true },
			},
		};
		const { sink, events } = recordingSink();
		diffAndEmit(prev, next, sink);
		const ev = events.find((e) => e.kind === "review");
		expect(ev?.message).toContain("Security");
		expect(ev?.message).toContain("18/20");
	});

	it("emits nothing when snapshots are identical", () => {
		const s = freshSnapshot();
		const { sink, events } = recordingSink();
		diffAndEmit(s, s, sink);
		expect(events).toEqual([]);
	});
});
