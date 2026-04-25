/**
 * fs.watch-driven snapshot refresher. Watches `.qult/state/` and
 * `.qult/specs/` for any change, debounces, then collects a fresh snapshot
 * and emits it via callbacks. Spec-add/remove flips the active spec.
 *
 * Linux's `fs.watch` does not support `recursive: true` reliably across
 * filesystems. We watch the two top-level directories non-recursively and
 * the `waves/` subdir of the active spec when known. Most state changes
 * write to a small set of known files; missing the rare nested edit is OK
 * — the next top-level event re-collects.
 */

import { existsSync, type FSWatcher, watch } from "node:fs";
import { qultDir, specsDir, wavesDir } from "../../state/paths.ts";
import type { ActiveSpec } from "../types.ts";
import { getActiveSpecForDashboard } from "./active-spec.ts";
import { diffAndEmit, type EventSink } from "./diff.ts";
import { collectSnapshot, type Snapshot } from "./snapshot.ts";

export interface WatcherCallbacks {
	onSnapshot: (snapshot: Snapshot) => void;
	onSpecChange: (spec: ActiveSpec | null) => void;
	onError: (file: string, message: string) => void;
	sink: EventSink;
}

export interface WatcherHandle {
	close: () => void;
	/** Force a refresh (test hook / UI request). */
	refresh: () => void;
}

const DEFAULT_DEBOUNCE_MS = 50;

export interface StartOptions {
	startedAt: number;
	debounceMs?: number;
	callbacks: WatcherCallbacks;
	now?: () => number;
}

export function startWatcher(opts: StartOptions): WatcherHandle {
	const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const now = opts.now ?? Date.now;
	const watchers: FSWatcher[] = [];
	let activeWavesWatcher: FSWatcher | null = null;
	let lastWatchedSpec: string | null = null;
	let lastSnapshot: Snapshot | null = null;
	let timer: NodeJS.Timeout | null = null;

	const refresh = (): void => {
		try {
			const snapshot = collectSnapshot({ startedAt: opts.startedAt, now: now() });
			if (lastSnapshot !== null) {
				diffAndEmit(lastSnapshot, snapshot, opts.callbacks.sink);
			}
			if (snapshot.activeSpec?.name !== lastSnapshot?.activeSpec?.name) {
				opts.callbacks.onSpecChange(snapshot.activeSpec);
				rebindWavesWatcher(snapshot.activeSpec?.name ?? null);
			}
			lastSnapshot = snapshot;
			opts.callbacks.onSnapshot(snapshot);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			opts.callbacks.onError("snapshot", msg);
		}
	};

	const scheduleRefresh = (): void => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			refresh();
		}, debounceMs);
	};

	const rebindWavesWatcher = (specName: string | null): void => {
		if (specName === lastWatchedSpec) return;
		if (activeWavesWatcher) {
			activeWavesWatcher.close();
			activeWavesWatcher = null;
		}
		lastWatchedSpec = specName;
		if (!specName) return;
		const dir = wavesDir(specName);
		if (!existsSync(dir)) return;
		try {
			activeWavesWatcher = watch(dir, scheduleRefresh);
			activeWavesWatcher.on("error", (e) =>
				opts.callbacks.onError(dir, e instanceof Error ? e.message : String(e)),
			);
		} catch (err) {
			opts.callbacks.onError(dir, err instanceof Error ? err.message : String(err));
		}
	};

	const watchDir = (dir: string): void => {
		if (!existsSync(dir)) return;
		try {
			const w = watch(dir, scheduleRefresh);
			w.on("error", (e) => opts.callbacks.onError(dir, e instanceof Error ? e.message : String(e)));
			watchers.push(w);
		} catch (err) {
			opts.callbacks.onError(dir, err instanceof Error ? err.message : String(err));
		}
	};

	// Top-level watches. State + spec dirs cover the bulk of changes; the
	// active spec's waves/ is added on top via rebind.
	const root = qultDir();
	if (existsSync(root)) {
		watchDir(`${root}/state`);
		watchDir(specsDir());
	}

	// Initial snapshot — also binds the active spec's waves watcher.
	const initialSpec = getActiveSpecForDashboard();
	rebindWavesWatcher(initialSpec?.name ?? null);
	refresh();

	return {
		refresh,
		close: () => {
			if (timer) clearTimeout(timer);
			for (const w of watchers) {
				try {
					w.close();
				} catch {
					/* already closed */
				}
			}
			if (activeWavesWatcher) {
				try {
					activeWavesWatcher.close();
				} catch {
					/* already closed */
				}
			}
		},
	};
}
