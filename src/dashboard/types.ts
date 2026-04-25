/**
 * Dashboard type definitions — the single source of truth for the in-memory
 * state shape and the reducer action union. Kept separate from store.ts so
 * tests and components can import types without pulling reducer logic.
 */

export type SpecPhase = "requirements" | "design" | "tasks" | "implementation" | "archived";

export interface ActiveSpec {
	name: string;
	phase: SpecPhase;
}

export type WaveStatus = "todo" | "in-progress" | "done";

export interface WaveSummary {
	number: number;
	title: string;
	status: WaveStatus;
	tasksDone: number;
	tasksTotal: number;
	startedAt: string | null;
	completedAt: string | null;
}

export type DetectorId =
	| "security"
	| "dep-vuln"
	| "hallucinated-package"
	| "test-quality"
	| "export";

export type DetectorStatus = "pass" | "warn" | "fail" | "skipped" | "never-run";

export interface DetectorSummary {
	id: DetectorId;
	status: DetectorStatus;
	pendingFixes: number;
	lastRunAt: number | null;
}

export interface ReviewStageEntry {
	score: number | null;
	threshold: number;
	passed: boolean | null;
}

export interface ReviewStageSummary {
	spec: ReviewStageEntry;
	quality: ReviewStageEntry;
	security: ReviewStageEntry;
	adversarial: ReviewStageEntry;
}

export type EventKind =
	| "wave-complete"
	| "wave-start"
	| "test-pass"
	| "review"
	| "detector"
	| "spec-switch"
	| "error";

export type EventVariant = "success" | "warning" | "error" | "info";

export interface DashboardEvent {
	id: string;
	ts: number;
	kind: EventKind;
	variant: EventVariant;
	message: string;
}

export interface TerminalSize {
	columns: number;
	rows: number;
}

export interface DashboardState {
	qultVersion: string;
	startedAt: number;
	now: number;

	activeSpec: ActiveSpec | null;
	waves: WaveSummary[];
	detectors: DetectorSummary[];
	reviews: ReviewStageSummary;
	events: DashboardEvent[];
	errors: string[];

	terminal: TerminalSize;
}

export type DashboardAction =
	| { type: "snapshot-replace"; snapshot: Omit<DashboardState, "events" | "errors" | "terminal"> }
	| { type: "active-spec-changed"; spec: ActiveSpec | null }
	| { type: "terminal-resized"; columns: number; rows: number }
	| { type: "event-pushed"; event: DashboardEvent }
	| { type: "parse-error"; file: string; error: string }
	| { type: "tick"; now: number };

export const REVIEW_THRESHOLD_DEFAULT = 17;

export const ALL_DETECTOR_IDS: readonly DetectorId[] = [
	"security",
	"dep-vuln",
	"hallucinated-package",
	"test-quality",
	"export",
];
