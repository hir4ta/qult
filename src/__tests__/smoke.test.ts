import { describe, expect, it } from "vitest";

describe("smoke test", () => {
	it("types module exports expected interfaces", async () => {
		const types = await import("../types.ts");
		expect(types).toBeDefined();
		expect(typeof types).toBe("object");
	});

	it("dispatcher module exports dispatch function", async () => {
		const dispatcher = await import("../hooks/dispatcher.ts");
		expect(dispatcher.dispatch).toBeDefined();
		expect(typeof dispatcher.dispatch).toBe("function");
	});
});
