/**
 * Wave 1 smoke test — confirms the dashboard skeleton renders with Ink and
 * the static "Hello qult dashboard" text is present.
 *
 * Wave 3 swaps this for per-component snapshot tests once the real layout
 * lands. We keep the smoke test as a guard against accidental breakage of
 * the dynamic-import / render pipeline.
 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../../dashboard/components/App.tsx";

describe("dashboard smoke", () => {
	it("renders the Wave 1 skeleton with the Hello banner", () => {
		const { lastFrame, unmount } = render(<App />);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("qult");
		expect(frame).toContain("dashboard");
		expect(frame).toContain("Hello qult dashboard");
		expect(frame).toContain("Press");
		unmount();
	});
});
