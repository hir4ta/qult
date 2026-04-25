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
	if (!process.stdout.isTTY) {
		const { printPlainSnapshot } = await import("./plain-snapshot.ts");
		process.stdout.write(`qult dashboard ${VERSION} (non-TTY)\n`);
		printPlainSnapshot();
		return 0;
	}

	const [{ render }, { App }, { createElement }] = await Promise.all([
		import("ink"),
		import("./components/App.tsx"),
		import("react"),
	]);

	const { waitUntilExit } = render(createElement(App));
	await waitUntilExit();
	return 0;
}
