import { describe, expect, it } from "vitest";
import { initialState, makeEvent, reducer } from "../../dashboard/state/store.ts";
import type { DashboardState } from "../../dashboard/types.ts";

function freshState(): DashboardState {
	return initialState({ startedAt: 1000, terminal: { columns: 100, rows: 30 } });
}

describe("dashboard reducer", () => {
	it("initialState seeds detectors with never-run status", () => {
		const s = freshState();
		expect(s.detectors).toHaveLength(5);
		for (const d of s.detectors) expect(d.status).toBe("never-run");
		expect(s.events).toEqual([]);
		expect(s.errors).toEqual([]);
	});

	it("snapshot-replace overwrites domain fields but keeps events / errors / terminal", () => {
		const s = freshState();
		const next = reducer(s, {
			type: "snapshot-replace",
			snapshot: {
				qultVersion: s.qultVersion,
				startedAt: s.startedAt,
				now: 9999,
				activeSpec: { name: "demo", phase: "implementation" },
				waves: [
					{
						number: 1,
						title: "x",
						status: "done",
						tasksDone: 5,
						tasksTotal: 5,
						startedAt: null,
						completedAt: null,
					},
				],
				detectors: s.detectors,
				reviews: s.reviews,
			},
		});
		expect(next.activeSpec?.name).toBe("demo");
		expect(next.waves).toHaveLength(1);
		expect(next.terminal).toEqual(s.terminal);
		expect(next.events).toEqual([]);
	});

	it("active-spec-changed clears waves when spec becomes null", () => {
		const s = freshState();
		const populated = reducer(s, {
			type: "snapshot-replace",
			snapshot: {
				qultVersion: s.qultVersion,
				startedAt: s.startedAt,
				now: 1,
				activeSpec: { name: "x", phase: "tasks" },
				waves: [
					{
						number: 1,
						title: "t",
						status: "todo",
						tasksDone: 0,
						tasksTotal: 1,
						startedAt: null,
						completedAt: null,
					},
				],
				detectors: s.detectors,
				reviews: s.reviews,
			},
		});
		const cleared = reducer(populated, { type: "active-spec-changed", spec: null });
		expect(cleared.activeSpec).toBeNull();
		expect(cleared.waves).toEqual([]);
	});

	it("event-pushed appends events bounded to 100", () => {
		let s = freshState();
		for (let i = 0; i < 105; i++) {
			s = reducer(s, {
				type: "event-pushed",
				event: makeEvent(`e${i}`, { kind: "review", variant: "info", message: `m${i}` }, i),
			});
		}
		expect(s.events).toHaveLength(100);
		expect(s.events[0]?.message).toBe("m5");
	});

	it("parse-error appends bounded errors", () => {
		let s = freshState();
		for (let i = 0; i < 7; i++) {
			s = reducer(s, { type: "parse-error", file: `f${i}`, error: "bad json" });
		}
		expect(s.errors).toHaveLength(5);
		expect(s.errors[0]).toContain("f2:");
	});

	it("terminal-resized updates the terminal field only", () => {
		const s = freshState();
		const next = reducer(s, { type: "terminal-resized", columns: 200, rows: 50 });
		expect(next.terminal).toEqual({ columns: 200, rows: 50 });
		expect(next.activeSpec).toBe(s.activeSpec);
	});

	it("tick advances `now`", () => {
		const s = freshState();
		const next = reducer(s, { type: "tick", now: 5555 });
		expect(next.now).toBe(5555);
	});
});
