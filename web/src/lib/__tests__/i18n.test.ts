import { describe, expect, it } from "vitest";
import { translations } from "../i18n";

describe("i18n translations", () => {
	it("all keys have both EN and JA translations", () => {
		for (const [key, value] of Object.entries(translations)) {
			expect(value, `Key "${key}" missing 'en'`).toHaveProperty("en");
			expect(value, `Key "${key}" missing 'ja'`).toHaveProperty("ja");
			expect((value as { en: string }).en, `Key "${key}" has empty 'en'`).toBeTruthy();
			expect((value as { ja: string }).ja, `Key "${key}" has empty 'ja'`).toBeTruthy();
		}
	});

	it("has at least 50 translation keys", () => {
		expect(Object.keys(translations).length).toBeGreaterThanOrEqual(50);
	});

	it("has nav keys", () => {
		expect(translations).toHaveProperty("nav.overview");
		expect(translations).toHaveProperty("nav.tasks");
		expect(translations).toHaveProperty("nav.knowledge");
		expect(translations).toHaveProperty("nav.activity");
	});

	it("has review keys", () => {
		expect(translations).toHaveProperty("review.approve");
		expect(translations).toHaveProperty("review.requestChanges");
	});
});
