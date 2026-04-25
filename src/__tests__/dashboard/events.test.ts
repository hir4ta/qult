import { describe, expect, it } from "vitest";
import { EventStream } from "../../dashboard/state/events.ts";

describe("EventStream", () => {
	it("rejects capacity below 1", () => {
		expect(() => new EventStream(0)).toThrow();
	});

	it("assigns monotonic ids and timestamps", () => {
		const s = new EventStream();
		const a = s.push({ kind: "test-pass", variant: "success", message: "ok" }, 1000);
		const b = s.push({ kind: "test-pass", variant: "success", message: "ok" }, 2000);
		expect(a.id).toBe("evt-1");
		expect(b.id).toBe("evt-2");
		expect(a.ts).toBe(1000);
		expect(b.ts).toBe(2000);
	});

	it("drops oldest when over capacity", () => {
		const s = new EventStream(2);
		s.push({ kind: "review", variant: "info", message: "a" }, 1);
		s.push({ kind: "review", variant: "info", message: "b" }, 2);
		s.push({ kind: "review", variant: "info", message: "c" }, 3);
		const all = s.all();
		expect(all).toHaveLength(2);
		expect(all.map((e) => e.message)).toEqual(["b", "c"]);
	});

	it("recent(n) returns the trailing n events", () => {
		const s = new EventStream();
		for (let i = 0; i < 5; i++) {
			s.push({ kind: "detector", variant: "warning", message: `e${i}` }, i);
		}
		const tail = s.recent(3);
		expect(tail.map((e) => e.message)).toEqual(["e2", "e3", "e4"]);
	});

	it("recent(0) returns empty", () => {
		const s = new EventStream();
		s.push({ kind: "detector", variant: "info", message: "x" });
		expect(s.recent(0)).toEqual([]);
	});

	it("clear() empties the buffer but keeps the seq counter", () => {
		const s = new EventStream();
		s.push({ kind: "test-pass", variant: "success", message: "a" });
		s.clear();
		expect(s.size()).toBe(0);
		const next = s.push({ kind: "test-pass", variant: "success", message: "b" });
		expect(next.id).toBe("evt-2");
	});
});
