/**
 * Dashboard reducer + initial state factory. Pure / synchronous — easy to
 * unit test by feeding it actions and comparing the resulting state.
 *
 * The reducer holds no side effects: file reads happen in `snapshot.ts`,
 * fs.watch in `watcher.ts`. We dispatch already-collected snapshots via the
 * `snapshot-replace` action so the reducer doesn't need fs access.
 */

import type { DashboardAction, DashboardEvent, DashboardState } from "../types.ts";
import { emptySnapshot } from "./snapshot.ts";

export interface InitialOptions {
	startedAt: number;
	terminal: { columns: number; rows: number };
}

const MAX_EVENTS_IN_STATE = 100;
const MAX_ERRORS_IN_STATE = 5;

export function initialState(opts: InitialOptions): DashboardState {
	return {
		...emptySnapshot(opts.startedAt),
		events: [],
		errors: [],
		terminal: opts.terminal,
	};
}

export function reducer(state: DashboardState, action: DashboardAction): DashboardState {
	switch (action.type) {
		case "snapshot-replace":
			return {
				...state,
				...action.snapshot,
			};
		case "active-spec-changed":
			return {
				...state,
				activeSpec: action.spec,
				// Clear waves/detectors/reviews when spec changes — the next
				// snapshot will repopulate them. Avoids showing stale data.
				waves: action.spec === null ? [] : state.waves,
			};
		case "terminal-resized":
			return {
				...state,
				terminal: { columns: action.columns, rows: action.rows },
			};
		case "event-pushed":
			return {
				...state,
				events: appendBounded(state.events, action.event, MAX_EVENTS_IN_STATE),
			};
		case "parse-error":
			return {
				...state,
				errors: appendBounded(state.errors, `${action.file}: ${action.error}`, MAX_ERRORS_IN_STATE),
			};
		case "tick":
			return { ...state, now: action.now };
	}
}

function appendBounded<T>(arr: readonly T[], next: T, max: number): T[] {
	const out = [...arr, next];
	while (out.length > max) out.shift();
	return out;
}

/** Helper for tests / hooks: build an event without going through EventStream. */
export function makeEvent(
	id: string,
	args: Omit<DashboardEvent, "id" | "ts">,
	nowMs: number = Date.now(),
): DashboardEvent {
	return { id, ts: nowMs, ...args };
}
