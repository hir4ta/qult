/**
 * Bind exit keys for the dashboard: `q` (quit) and `Ctrl+C`.
 *
 * Ink translates Ctrl+C into the `ctrl` modifier with `c`. We also listen
 * for SIGINT at the process level as a belt-and-suspenders so the TUI
 * always has a clean exit path even if Ink's stdin handling drops the
 * keypress (e.g. during a heavy render).
 */

import { useApp, useInput } from "ink";
import { useEffect } from "react";

export function useExitKeys(): void {
	const { exit } = useApp();

	useInput((input, key) => {
		if (input === "q" || (key.ctrl && input === "c")) {
			exit();
		}
	});

	useEffect(() => {
		const handler = (): void => exit();
		process.on("SIGINT", handler);
		process.on("SIGTERM", handler);
		return () => {
			process.off("SIGINT", handler);
			process.off("SIGTERM", handler);
		};
	}, [exit]);
}
