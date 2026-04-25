/**
 * Bounded ring-buffer of dashboard events. Drops oldest on overflow so the
 * UI's `EventLog` always has fresh data even on long-running sessions. Pure
 * data structure — no fs / ink dependencies.
 */

import type { DashboardEvent, EventKind, EventVariant } from "../types.ts";

export interface PushArgs {
	kind: EventKind;
	variant: EventVariant;
	message: string;
}

const DEFAULT_CAPACITY = 100;

export class EventStream {
	private readonly capacity: number;
	private readonly buf: DashboardEvent[] = [];
	private seq = 0;

	constructor(capacity = DEFAULT_CAPACITY) {
		if (capacity < 1) throw new Error("EventStream capacity must be >= 1");
		this.capacity = capacity;
	}

	push(args: PushArgs, nowMs: number = Date.now()): DashboardEvent {
		this.seq += 1;
		const event: DashboardEvent = {
			id: `evt-${this.seq}`,
			ts: nowMs,
			kind: args.kind,
			variant: args.variant,
			message: args.message,
		};
		this.buf.push(event);
		while (this.buf.length > this.capacity) this.buf.shift();
		return event;
	}

	recent(n: number): DashboardEvent[] {
		if (n <= 0) return [];
		return this.buf.slice(-n);
	}

	all(): DashboardEvent[] {
		return [...this.buf];
	}

	size(): number {
		return this.buf.length;
	}

	clear(): void {
		this.buf.length = 0;
	}
}
