import { describe, expect, it } from "vitest";
import { lerpHex, sampleGradient } from "../../dashboard/theme.ts";

describe("lerpHex", () => {
	it("returns the start color at t=0", () => {
		expect(lerpHex("#ff0000", "#00ff00", 0)).toBe("#ff0000");
	});
	it("returns the end color at t=1", () => {
		expect(lerpHex("#ff0000", "#00ff00", 1)).toBe("#00ff00");
	});
	it("interpolates each channel at t=0.5", () => {
		// (255+0)/2 = 127.5 → rounds to 128 → 0x80
		expect(lerpHex("#ff0000", "#00ff00", 0.5)).toBe("#808000");
	});
	it("clamps t into [0, 1]", () => {
		expect(lerpHex("#ff0000", "#00ff00", -1)).toBe("#ff0000");
		expect(lerpHex("#ff0000", "#00ff00", 2)).toBe("#00ff00");
	});
});

describe("sampleGradient", () => {
	it("falls back to fg when stops is empty", () => {
		expect(sampleGradient([], 0.5)).toMatch(/^#[0-9a-f]{6}$/);
	});
	it("returns the single stop when stops.length === 1", () => {
		expect(sampleGradient(["#abcdef"], 0.5)).toBe("#abcdef");
	});
	it("hits each stop exactly at the segment boundaries", () => {
		const stops = ["#000000", "#ff0000", "#00ff00"];
		expect(sampleGradient(stops, 0)).toBe("#000000");
		expect(sampleGradient(stops, 0.5)).toBe("#ff0000");
		expect(sampleGradient(stops, 1)).toBe("#00ff00");
	});
	it("interpolates within a segment", () => {
		const stops = ["#000000", "#ff0000"];
		// 25% of the way → red channel ≈ 64 (0x40)
		expect(sampleGradient(stops, 0.25)).toBe("#400000");
	});
});
