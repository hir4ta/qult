import { describe, expect, it } from "vitest";
import { isNewer } from "../self-update.ts";

describe("self-update: isNewer", () => {
	it("detects newer major version", () => {
		expect(isNewer("v2.0.0", "v1.0.0")).toBe(true);
	});

	it("detects newer minor version", () => {
		expect(isNewer("v0.16.0", "v0.15.1")).toBe(true);
	});

	it("detects newer patch version", () => {
		expect(isNewer("v0.15.2", "v0.15.1")).toBe(true);
	});

	it("returns false for same version", () => {
		expect(isNewer("v0.15.1", "v0.15.1")).toBe(false);
	});

	it("returns false for older version", () => {
		expect(isNewer("v0.14.0", "v0.15.1")).toBe(false);
	});

	it("handles versions without v prefix", () => {
		expect(isNewer("0.16.0", "0.15.1")).toBe(true);
	});
});
