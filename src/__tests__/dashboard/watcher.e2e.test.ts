import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Snapshot } from "../../dashboard/state/snapshot.ts";
import { startWatcher } from "../../dashboard/state/watcher.ts";
import type { ActiveSpec } from "../../dashboard/types.ts";
import { setProjectRoot } from "../../state/paths.ts";

let tmpRoot = "";

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "qult-dash-watcher-"));
	mkdirSync(join(tmpRoot, ".qult", "state"), { recursive: true });
	mkdirSync(join(tmpRoot, ".qult", "specs"), { recursive: true });
	setProjectRoot(tmpRoot);
});

afterEach(() => {
	setProjectRoot(null);
	rmSync(tmpRoot, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Recorded {
	snapshots: Snapshot[];
	specChanges: Array<ActiveSpec | null>;
	events: Array<{ kind: string; message: string }>;
	errors: Array<{ file: string; message: string }>;
}

function recorder() {
	const r: Recorded = { snapshots: [], specChanges: [], events: [], errors: [] };
	return {
		recorded: r,
		callbacks: {
			onSnapshot: (s: Snapshot) => r.snapshots.push(s),
			onSpecChange: (s: ActiveSpec | null) => r.specChanges.push(s),
			onError: (file: string, message: string) => r.errors.push({ file, message }),
			sink: { push: (e: { kind: string; message: string }) => r.events.push(e) },
		},
	};
}

describe("watcher e2e", () => {
	it("emits an initial snapshot on start", async () => {
		const rec = recorder();
		const handle = startWatcher({
			startedAt: 0,
			callbacks: rec.callbacks,
			debounceMs: 5,
		});
		await sleep(30);
		expect(rec.recorded.snapshots.length).toBeGreaterThanOrEqual(1);
		const first = rec.recorded.snapshots[0];
		expect(first?.activeSpec).toBeNull();
		handle.close();
	});

	it("detects new spec creation and emits spec-switch event", async () => {
		const rec = recorder();
		const handle = startWatcher({
			startedAt: 0,
			callbacks: rec.callbacks,
			debounceMs: 5,
		});
		await sleep(30);
		// Create a fresh spec on disk.
		const specDir = join(tmpRoot, ".qult", "specs", "alpha");
		mkdirSync(specDir, { recursive: true });
		writeFileSync(join(specDir, "requirements.md"), "# req");
		// Wait for fs.watch + debounce + diff cycle.
		await sleep(150);
		const last = rec.recorded.snapshots.at(-1);
		expect(last?.activeSpec).toEqual({ name: "alpha", phase: "requirements" });
		expect(rec.recorded.specChanges.at(-1)).toEqual({ name: "alpha", phase: "requirements" });
		expect(rec.recorded.events.some((e) => e.kind === "spec-switch")).toBe(true);
		handle.close();
	});

	it("refresh() forces a synchronous re-collect", () => {
		const rec = recorder();
		const handle = startWatcher({
			startedAt: 0,
			callbacks: rec.callbacks,
			debounceMs: 5,
		});
		const before = rec.recorded.snapshots.length;
		handle.refresh();
		expect(rec.recorded.snapshots.length).toBe(before + 1);
		handle.close();
	});

	it("close() stops further snapshots", async () => {
		const rec = recorder();
		const handle = startWatcher({
			startedAt: 0,
			callbacks: rec.callbacks,
			debounceMs: 5,
		});
		await sleep(20);
		handle.close();
		const after = rec.recorded.snapshots.length;
		writeFileSync(join(tmpRoot, ".qult", "state", "current.json"), "{}");
		await sleep(100);
		expect(rec.recorded.snapshots.length).toBe(after);
	});
});
