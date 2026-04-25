/**
 * Wave 4 tests: ErrorBanner, plain-snapshot fallback, App tier rendering.
 *
 * `useTerminalSize` itself is exercised indirectly via App, where we drive
 * the columns/rows via the testing library's stdout shim. ink-testing-library
 * doesn't support resize events natively, so we cover hysteresis with the
 * pure `computeLayout` tests in `layout.test.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBanner } from "../../dashboard/components/ErrorBanner.tsx";
import { printPlainSnapshot } from "../../dashboard/plain-snapshot.ts";
import { setProjectRoot } from "../../state/paths.ts";

let tmpRoot = "";
beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "qult-dash-w4-"));
	mkdirSync(join(tmpRoot, ".qult", "state"), { recursive: true });
	mkdirSync(join(tmpRoot, ".qult", "specs"), { recursive: true });
	setProjectRoot(tmpRoot);
});
afterEach(() => {
	setProjectRoot(null);
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ErrorBanner", () => {
	it("renders nothing when there are no errors", () => {
		const { lastFrame } = render(<ErrorBanner errors={[]} />);
		expect(lastFrame()).toBe("");
	});

	it("renders the latest error in an Alert", () => {
		const frame =
			render(<ErrorBanner errors={["old issue", "current.json: bad json"]} />).lastFrame() ?? "";
		expect(frame).toContain("current.json");
		expect(frame.toLowerCase()).toContain("dashboard error");
	});
});

describe("printPlainSnapshot", () => {
	it("emits a header with version and 'no active spec' line", () => {
		const chunks: string[] = [];
		const stream = {
			write: (s: string) => {
				chunks.push(s);
				return true;
			},
		} as unknown as NodeJS.WriteStream;
		printPlainSnapshot(stream);
		const out = chunks.join("");
		expect(out).toContain("qult dashboard");
		expect(out).toContain("active spec: <none>");
		expect(out).toContain("waves:");
		expect(out).toContain("detectors:");
		expect(out).toContain("reviews:");
	});

	it("includes the active spec when present", () => {
		const dir = join(tmpRoot, ".qult", "specs", "alpha");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "requirements.md"), "# req");
		writeFileSync(join(dir, "design.md"), "# design");
		const chunks: string[] = [];
		const stream = {
			write: (s: string) => {
				chunks.push(s);
				return true;
			},
		} as unknown as NodeJS.WriteStream;
		printPlainSnapshot(stream);
		const out = chunks.join("");
		expect(out).toContain("active spec: alpha (design)");
	});
});

describe("non-TTY runDashboard path", () => {
	it("returns 0 and writes a snapshot block when stdout is not a TTY", async () => {
		const { runDashboard } = await import("../../dashboard/index.ts");
		const writes: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		const originalIsTTY = process.stdout.isTTY;
		process.stdout.isTTY = false;
		const writeSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((chunk: string | Uint8Array) => {
				writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
				return true;
			});
		try {
			const code = await runDashboard();
			expect(code).toBe(0);
			const out = writes.join("");
			expect(out).toContain("non-TTY");
			expect(out).toContain("active spec");
		} finally {
			writeSpy.mockRestore();
			process.stdout.isTTY = originalIsTTY;
			// touch originalWrite to keep TS happy about unused
			void originalWrite;
		}
	});
});
