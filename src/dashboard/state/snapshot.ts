/**
 * Build a fresh snapshot of dashboard state from on-disk artifacts.
 *
 * This is the read-side counterpart to the watcher: any time something
 * meaningful changes on disk we recompute the whole snapshot and feed it
 * into the reducer via a `snapshot-replace` action. The cost is dominated
 * by a handful of small JSON / Markdown reads, well under 5 ms in practice.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	readCurrent,
	readPendingFixes,
	readStageScores,
	type StageScoresState,
} from "../../state/json-state.ts";
import { wavesDir } from "../../state/paths.ts";
import { listWaveNumbers } from "../../state/spec.ts";
import { parseTasksMd } from "../../state/tasks-md.ts";
import { parseWaveMd } from "../../state/wave-md.ts";
import {
	type ActiveSpec,
	ALL_DETECTOR_IDS,
	type DashboardState,
	type DetectorId,
	type DetectorStatus,
	type DetectorSummary,
	REVIEW_THRESHOLD_DEFAULT,
	type ReviewStageEntry,
	type ReviewStageSummary,
	type WaveStatus,
	type WaveSummary,
} from "../types.ts";
import { getActiveSpecForDashboard } from "./active-spec.ts";

declare const __QULT_VERSION__: string;
const VERSION = typeof __QULT_VERSION__ !== "undefined" ? __QULT_VERSION__ : "0.0.0-dev";

export type Snapshot = Omit<DashboardState, "events" | "errors" | "terminal">;

export function emptySnapshot(now: number): Snapshot {
	return {
		qultVersion: VERSION,
		startedAt: now,
		now,
		activeSpec: null,
		waves: [],
		detectors: ALL_DETECTOR_IDS.map((id) => ({
			id,
			status: "never-run" as DetectorStatus,
			pendingFixes: 0,
			lastRunAt: null,
		})),
		reviews: emptyReviews(),
		// events / errors / terminal are populated by the reducer / hooks.
	};
}

function emptyReviews(): ReviewStageSummary {
	const entry: ReviewStageEntry = {
		score: null,
		threshold: REVIEW_THRESHOLD_DEFAULT,
		passed: null,
	};
	return {
		spec: { ...entry },
		quality: { ...entry },
		security: { ...entry },
		adversarial: { ...entry },
	};
}

function readWaveSummaries(specName: string): WaveSummary[] {
	const dir = wavesDir(specName);
	if (!existsSync(dir)) return [];
	const nums = listWaveNumbers(specName).sort((a, b) => a - b);
	const tasksDoc = readTasksDoc(specName);
	const summaries: WaveSummary[] = [];
	for (const num of nums) {
		const file = join(dir, `wave-${String(num).padStart(2, "0")}.md`);
		if (!existsSync(file)) continue;
		let parsed: ReturnType<typeof parseWaveMd> | null = null;
		try {
			parsed = parseWaveMd(readFileSync(file, "utf8"));
		} catch {
			parsed = null;
		}
		const { tasksDone, tasksTotal } = countWaveTasks(tasksDoc, num);
		const status: WaveStatus = parsed?.completedAt
			? "done"
			: parsed?.startedAt
				? "in-progress"
				: "todo";
		summaries.push({
			number: num,
			title: parsed?.title ?? `Wave ${num}`,
			status,
			tasksDone,
			tasksTotal,
			startedAt: parsed?.startedAt ?? null,
			completedAt: parsed?.completedAt ?? null,
		});
	}
	return summaries;
}

interface TasksDocLike {
	waves: Array<{ num: number; tasks: Array<{ status: string }> }>;
}

function readTasksDoc(specName: string): TasksDocLike | null {
	const path = join(wavesDir(specName), "..", "tasks.md");
	if (!existsSync(path)) return null;
	try {
		return parseTasksMd(readFileSync(path, "utf8")) as TasksDocLike;
	} catch {
		return null;
	}
}

function countWaveTasks(
	doc: TasksDocLike | null,
	waveNum: number,
): { tasksDone: number; tasksTotal: number } {
	if (!doc) return { tasksDone: 0, tasksTotal: 0 };
	const wave = doc.waves.find((w) => w.num === waveNum);
	if (!wave) return { tasksDone: 0, tasksTotal: 0 };
	const total = wave.tasks.length;
	const done = wave.tasks.filter((t) => t.status === "done").length;
	return { tasksDone: done, tasksTotal: total };
}

function readDetectorSummaries(): DetectorSummary[] {
	const fixes = readPendingFixes();
	const counts = new Map<DetectorId, number>();
	for (const id of ALL_DETECTOR_IDS) counts.set(id, 0);
	for (const fix of fixes.fixes) {
		const det = fix.detector as DetectorId;
		if (counts.has(det)) counts.set(det, (counts.get(det) ?? 0) + 1);
	}
	return ALL_DETECTOR_IDS.map((id) => {
		const pendingFixes = counts.get(id) ?? 0;
		const status: DetectorStatus = pendingFixes > 0 ? "fail" : "never-run";
		return { id, status, pendingFixes, lastRunAt: null };
	});
}

function readReviewSummary(scores: StageScoresState): ReviewStageSummary {
	const out = emptyReviews();
	const map: Record<keyof ReviewStageSummary, keyof StageScoresState["review"]> = {
		spec: "Spec",
		quality: "Quality",
		security: "Security",
		adversarial: "Adversarial",
	};
	for (const [outKey, inKey] of Object.entries(map) as Array<
		[keyof ReviewStageSummary, keyof StageScoresState["review"]]
	>) {
		const stage = scores.review[inKey];
		if (!stage) continue;
		const total = sumScores(stage.scores);
		out[outKey] = {
			score: total,
			threshold: REVIEW_THRESHOLD_DEFAULT,
			passed: total >= REVIEW_THRESHOLD_DEFAULT,
		};
	}
	return out;
}

function sumScores(scores: Record<string, number>): number {
	let n = 0;
	for (const v of Object.values(scores)) n += v;
	return n;
}

export interface CollectOptions {
	startedAt: number;
	now: number;
	activeSpecOverride?: ActiveSpec | null;
}

export function collectSnapshot(opts: CollectOptions): Snapshot {
	const { startedAt, now } = opts;
	const activeSpec = opts.activeSpecOverride ?? getActiveSpecForDashboard();
	if (activeSpec === null) {
		return { ...emptySnapshot(now), startedAt, activeSpec: null };
	}
	const waves = readWaveSummaries(activeSpec.name);
	const detectors = readDetectorSummaries();
	let reviews: ReviewStageSummary;
	try {
		reviews = readReviewSummary(readStageScores());
	} catch {
		reviews = emptyReviews();
	}
	// Touching readCurrent to keep file-watch consistency (its data is part
	// of "what the dashboard shows" even though we don't surface fields yet
	// — a Wave 3 component will).
	readCurrent();
	return {
		qultVersion: VERSION,
		startedAt,
		now,
		activeSpec,
		waves,
		detectors,
		reviews,
	};
}
