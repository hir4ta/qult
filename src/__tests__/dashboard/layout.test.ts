import { describe, expect, it } from "vitest";
import { computeLayout, HYSTERESIS } from "../../dashboard/state/layout.ts";

describe("computeLayout", () => {
	it("classifies wide / medium / narrow by columns", () => {
		expect(computeLayout(120, 40).tier).toBe("wide");
		expect(computeLayout(75, 40).tier).toBe("medium");
		expect(computeLayout(50, 40).tier).toBe("narrow");
	});

	it("reserves at least 3 lines for the event log on tiny terminals", () => {
		const out = computeLayout(120, 5);
		expect(out.eventLogLines).toBeGreaterThanOrEqual(3);
	});

	it("scales the event log proportionally on tall terminals", () => {
		const wide = computeLayout(120, 40);
		const medium = computeLayout(75, 40);
		expect(wide.eventLogLines).toBeGreaterThan(medium.eventLogLines);
	});

	it("applies hysteresis around the wide ↔ medium boundary", () => {
		// At 89 cols we'd be medium, but if the previous tier was wide and we
		// stay within HYSTERESIS, we stick on wide to avoid flicker.
		const sticky = computeLayout(90 - HYSTERESIS, 30, "wide");
		expect(sticky.tier).toBe("wide");
		// Fall through once we exceed the band.
		const fellOff = computeLayout(90 - HYSTERESIS - 1, 30, "wide");
		expect(fellOff.tier).toBe("medium");
	});

	it("applies hysteresis around the medium ↔ narrow boundary", () => {
		const sticky = computeLayout(60 - HYSTERESIS, 30, "medium");
		expect(sticky.tier).toBe("medium");
		const fellOff = computeLayout(60 - HYSTERESIS - 1, 30, "medium");
		expect(fellOff.tier).toBe("narrow");
	});

	it("hysteresis is a no-op when no previous tier is supplied", () => {
		expect(computeLayout(89, 30).tier).toBe("medium");
	});

	it("does not stick on medium when crossing fully into wide", () => {
		// Bug regression: previously the medium-tier hysteresis branch used
		// `cols < WIDE_THRESHOLD + HYSTERESIS` as its upper bound, which
		// kept the UI on medium at 91 cols even though we'd already cleared
		// the wide threshold (90) by more than HYSTERESIS.
		expect(computeLayout(95, 30, "medium").tier).toBe("wide");
	});

	it("stays on medium just below the wide boundary (within hysteresis)", () => {
		// Should still stick on medium right at WIDE_THRESHOLD - 1.
		expect(computeLayout(89, 30, "medium").tier).toBe("medium");
	});
});
