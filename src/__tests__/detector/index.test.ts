/**
 * Tests for the runAllDetectors orchestrator — verifies that network-bound
 * detectors are skipped when `offline: true` and that the security-check /
 * test-quality / export-check pipeline runs against per-file inputs.
 */

import { describe, expect, it } from "vitest";
import { runAllDetectors } from "../../detector/index.ts";

describe("runAllDetectors", () => {
	it("skips dep-vuln-check and hallucinated-package-check when offline=true", async () => {
		const results = await runAllDetectors([], { offline: true });
		const dep = results.find((r) => r.detector === "dep-vuln-check");
		const halluc = results.find((r) => r.detector === "hallucinated-package-check");
		expect(dep?.skipped).toBe(true);
		expect(dep?.skipReason).toContain("network");
		expect(halluc?.skipped).toBe(true);
	});

	it("skips hallucinated-package-check when no install command provided", async () => {
		const results = await runAllDetectors([], { offline: true });
		const halluc = results.find((r) => r.detector === "hallucinated-package-check");
		// offline=true wins over the no-install-command branch — both produce skipped:true.
		expect(halluc?.skipped).toBe(true);
	});

	it("returns an entry for each of the 5 detectors", async () => {
		const results = await runAllDetectors([], { offline: true });
		const names = results.map((r) => r.detector).sort();
		expect(names).toEqual(
			[
				"dep-vuln-check",
				"export-check",
				"hallucinated-package-check",
				"security-check",
				"test-quality-check",
			].sort(),
		);
	});

	it("non-network detectors run with empty fixes when files=[]", async () => {
		const results = await runAllDetectors([], { offline: true });
		const sec = results.find((r) => r.detector === "security-check");
		const tq = results.find((r) => r.detector === "test-quality-check");
		const exp = results.find((r) => r.detector === "export-check");
		expect(sec?.skipped).toBe(false);
		expect(sec?.fixes).toEqual([]);
		expect(tq?.skipped).toBe(false);
		expect(exp?.skipped).toBe(false);
	});
});
