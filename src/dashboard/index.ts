/**
 * `qult dashboard` entry — render the Ink TUI when stdout is a TTY,
 * otherwise emit a single plain-text snapshot and exit (CI / pipe friendly).
 *
 * All Ink / React imports are kept dynamic so this module pays the bundle
 * cost only when actually invoked. The CLI dispatcher in `src/cli/index.ts`
 * lazy-loads us via `await import("../dashboard/index.ts")`.
 */

declare const __QULT_VERSION__: string;
const VERSION = typeof __QULT_VERSION__ !== "undefined" ? __QULT_VERSION__ : "0.0.0-dev";

export async function runDashboard(): Promise<number> {
	// Ink calls `process.stdin.setRawMode()` for `useInput`. That throws on
	// any pipe / redirect / IDE terminal that allocates only a stdout TTY,
	// so both ends must be a real TTY before we render the interactive UI.
	if (!process.stdout.isTTY || !process.stdin.isTTY) {
		const { printPlainSnapshot } = await import("./plain-snapshot.ts");
		process.stdout.write(`qult dashboard ${VERSION} (non-TTY)\n`);
		printPlainSnapshot();
		return 0;
	}

	// React, when bundled from its CJS source, comes back as `{ default: <module> }`
	// — there are no named exports on the namespace object. Pull `default` first
	// then destructure `createElement` off it.
	const [{ render }, { App }, reactMod] = await Promise.all([
		import("ink"),
		import("./components/App.tsx"),
		import("react"),
	]);
	const React = reactMod.default ?? reactMod;

	const { waitUntilExit } = render(React.createElement(App));
	await waitUntilExit();
	return 0;
}
