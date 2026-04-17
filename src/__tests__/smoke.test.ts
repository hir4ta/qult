import { describe, expect, it } from "vitest";

describe("smoke test", () => {
	it("types module exports expected interfaces", async () => {
		const types = await import("../types.ts");
		expect(types).toBeDefined();
		expect(typeof types).toBe("object");
	});

	it("mcp-server module loads without errors", async () => {
		const mcp = await import("../mcp-server.ts");
		expect(mcp).toBeDefined();
		expect(typeof mcp).toBe("object");
	});
});
