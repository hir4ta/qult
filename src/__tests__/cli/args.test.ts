import { describe, expect, it } from "vitest";
import { ArgsError, parseArgs } from "../../cli/args.ts";

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

	it("throws ArgsError when a value-flag is followed by another flag", () => {
		expect(() => parseArgs(["--agent", "--force"], ["agent"])).toThrowError(ArgsError);
	});

	it("throws ArgsError when a value-flag has no following arg", () => {
		expect(() => parseArgs(["--agent"], ["agent"])).toThrowError(/requires a value/);
	});

	it("throws ArgsError when a value-flag uses empty --flag= form", () => {
		expect(() => parseArgs(["--agent="], ["agent"])).toThrowError(/non-empty value/);
	});
});
