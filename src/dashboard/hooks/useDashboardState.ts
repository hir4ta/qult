/**
 * Bind the watcher + reducer together. Mounts a watcher on first render,
 * dispatches `snapshot-replace` / `event-pushed` / `parse-error` actions
 * as data flows in, and tears the watcher down on unmount.
 *
 * Wave 4 wires the terminal-resize and `tick` actions; Wave 3 keeps it
 * focused on filesystem-driven state.
 */

import { useEffect, useReducer, useRef } from "react";
import { EventStream } from "../state/events.ts";
import { initialState, reducer } from "../state/store.ts";
import { startWatcher, type WatcherHandle } from "../state/watcher.ts";
import type { DashboardState, TerminalSize } from "../types.ts";

interface Options {
	startedAt: number;
	terminal: TerminalSize;
}

export function useDashboardState(opts: Options): DashboardState {
	const [state, dispatch] = useReducer(
		reducer,
		{ startedAt: opts.startedAt, terminal: opts.terminal },
		initialState,
	);
	const handleRef = useRef<WatcherHandle | null>(null);

	useEffect(() => {
		const events = new EventStream();
		const handle = startWatcher({
			startedAt: opts.startedAt,
			callbacks: {
				onSnapshot: (snap) => dispatch({ type: "snapshot-replace", snapshot: snap }),
				onSpecChange: (spec) => dispatch({ type: "active-spec-changed", spec }),
				onError: (file, message) => dispatch({ type: "parse-error", file, error: message }),
				sink: {
					push: (e) => {
						const event = events.push(e);
						dispatch({ type: "event-pushed", event });
					},
				},
			},
		});
		handleRef.current = handle;
		return () => {
			handle.close();
			handleRef.current = null;
		};
	}, [opts.startedAt]);

	return state;
}
