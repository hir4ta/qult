/**
 * Wave 5 — `qult check --detect` UI snapshot tests. We avoid invoking
 * `runAllDetectors` against real files (slow, flaky on this machine) by
 * stubbing it in module scope: the DetectRunner only depends on the
 * exported function name, so we can intercept via vi.mock.
 */

import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../detector/index.ts", () => ({
	runAllDetectors: vi.fn(async (_files: string[], opts: { onProgress?: (e: unknown) => void }) => {
		const detectors = [
			"security-check",
			"dep-vuln-check",
			"hallucinated-package-check",
			"test-quality-check",
			"export-check",
		] as const;
		const results = detectors.map((d) => ({
			detector: d,
			fixes: d === "security-check" ? [{ errors: ["high"] }] : [],
			skipped: d === "hallucinated-package-check",
			skipReason: d === "hallucinated-package-check" ? "no install command provided" : undefined,
		}));
		for (const r of results) {
			opts.onProgress?.({ kind: "start", detector: r.detector });
			opts.onProgress?.({ kind: "complete", detector: r.detector, result: r });
		}
		return results;
	}),
}));

const { DetectRunner } = await import("../../dashboard/check-ui/DetectRunner.tsx");

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function tick(ms = 30): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

describe("DetectRunner", () => {
	it("renders header, progress bar, and all five detector rows", async () => {
		const { lastFrame, unmount } = render(
			<DetectRunner files={["foo.ts"]} cwd="/tmp" onComplete={() => {}} />,
		);
		await tick();
		const frame = lastFrame() ?? "";
		expect(frame).toContain("qult check --detect");
		for (const id of [
			"security-check",
			"dep-vuln-check",
			"hallucinated-package-check",
			"test-quality-check",
			"export-check",
		]) {
			expect(frame).toContain(id);
		}
		unmount();
	});

	it("shows badges and an Alert summary when all detectors finish", async () => {
		const onComplete = vi.fn();
		const { lastFrame, unmount } = render(
			<DetectRunner files={["foo.ts"]} cwd="/tmp" onComplete={onComplete} />,
		);
		// All detectors complete synchronously in the mock; the auto-exit
		// timer fires at +100ms. Sample the frame just before that.
		await tick(60);
		const rawFrame = lastFrame() ?? "";
		const frame = rawFrame.toLowerCase();
		// One fail (security-check), one skipped (hallucinated), three pass.
		expect(frame).toContain("fail");
		expect(frame).toContain("skipped");
		expect(frame).toContain("pass");
		expect(frame).toContain("100%");
		expect(frame).toContain("high-severity");
		expect(onComplete).toHaveBeenCalled();
		unmount();
	});
});
