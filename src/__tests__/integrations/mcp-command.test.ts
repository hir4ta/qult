import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpCommand } from "../../integrations/mcp-command.ts";

afterEach(() => {
	delete process.env.QULT_FORCE_NPX_MCP;
	delete process.env.QULT_FORCE_DIRECT_MCP;
});

describe("resolveMcpCommand", () => {
	it("QULT_FORCE_NPX_MCP=1 forces npx form", () => {
		process.env.QULT_FORCE_NPX_MCP = "1";
		expect(resolveMcpCommand()).toEqual({
			command: "npx",
			args: ["-y", "@hir4ta/qult", "mcp"],
		});
	});

	it("QULT_FORCE_DIRECT_MCP=1 forces direct qult form", () => {
		process.env.QULT_FORCE_DIRECT_MCP = "1";
		expect(resolveMcpCommand()).toEqual({
			command: "qult",
			args: ["mcp"],
		});
	});

	it("default (no override) returns one of the two known shapes", () => {
		const r = resolveMcpCommand();
		expect(["npx", "qult"]).toContain(r.command);
		if (r.command === "npx") {
			expect(r.args).toEqual(["-y", "@hir4ta/qult", "mcp"]);
		} else {
			expect(r.args).toEqual(["mcp"]);
		}
	});
});
