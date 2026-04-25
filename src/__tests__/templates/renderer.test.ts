import { describe, expect, it } from "vitest";
import {
	detectUndefinedVars,
	renderTemplate,
	UndefinedVariableError,
} from "../../templates/renderer.ts";

describe("renderTemplate", () => {
	it("substitutes {{VAR}} placeholders", () => {
		const out = renderTemplate("hello {{NAME}}, version {{VER}}", { NAME: "qult", VER: "1.1.0" });
		expect(out).toBe("hello qult, version 1.1.0");
	});

	it("throws UndefinedVariableError listing every missing key (sorted, deduped)", () => {
		expect(() => renderTemplate("{{B}} {{A}} {{B}} {{C}}", { B: "ok" })).toThrowError(
			UndefinedVariableError,
		);
		try {
			renderTemplate("{{B}} {{A}} {{B}} {{C}}", { B: "ok" });
		} catch (e) {
			expect((e as UndefinedVariableError).missing).toEqual(["A", "C"]);
		}
	});

	it("ignores lowercase or invalid placeholders (regex match only)", () => {
		const out = renderTemplate("{{name}} stays literal {{X-Y}} too", {});
		expect(out).toBe("{{name}} stays literal {{X-Y}} too");
	});

	it("detectUndefinedVars throws without rendering", () => {
		expect(() => detectUndefinedVars("{{MISSING}}", {})).toThrowError(UndefinedVariableError);
	});
});
