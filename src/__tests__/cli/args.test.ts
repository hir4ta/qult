import { describe, expect, it } from "vitest";
import { parseArgs } from "../../cli/args.ts";

describe("parseArgs", () => {
	it("collects positional arguments", () => {
		expect(parseArgs(["init", "claude"])).toEqual({
			positionals: ["init", "claude"],
			flags: {},
		});
	});

	it("treats --flag as boolean true", () => {
		expect(parseArgs(["--force"])).toEqual({ positionals: [], flags: { force: true } });
	});

	it("captures --flag value when listed in valueFlags", () => {
		expect(parseArgs(["--agent", "claude", "--force"], ["agent"])).toEqual({
			positionals: [],
			flags: { agent: "claude", force: true },
		});
	});

	it("supports --flag=value form", () => {
		expect(parseArgs(["--agent=cursor", "--json"])).toEqual({
			positionals: [],
			flags: { agent: "cursor", json: true },
		});
	});

	it("stops parsing at -- (positional escape)", () => {
		expect(parseArgs(["init", "--", "--not-a-flag"])).toEqual({
			positionals: ["init", "--not-a-flag"],
			flags: {},
		});
	});
});
