// TypeScript mirrors of Go types.
// Keep in sync manually (DEC-14).
//
// Source correspondence:
//   internal/dashboard/types.go → TaskDetail, SpecEntry, KnowledgeEntry, ActivityEntry,
//     KnowledgeStats, EpicSummary, EpicTaskSummary, DecisionEntry, MemoryHealthStats, StepItem
//   internal/spec/validate.go → ValidationReport, ValidationCheck
//   internal/spec/confidence.go → ConfidenceSummary, ConfidenceItem

// --- dashboard/types.go ---

export interface StepItem {
	text: string;
	done: boolean;
}

export interface WaveInfo {
	key: string;
	title: string;
	total: number;
	checked: number;
	isCurrent: boolean;
}

export interface TaskDetail {
	slug: string;
	epic_slug?: string;
	status: string;
	focus?: string;
	completed: number;
	total: number;
	has_blocker: boolean;
	blocker_text?: string;
	decisions?: string[];
	waves?: WaveInfo[];
	next_steps?: StepItem[];
	mod_files?: string[];
	started_at?: string;
	completed_at?: string;
	size?: string;
	spec_type?: string;
	review_status?: string;
	project_name?: string;
}

export interface SpecEntry {
	task_slug: string;
	file: string;
	size: number;
	updated_at: string;
}

export interface KnowledgeEntry {
	id: number;
	label: string;
	source: string;
	sub_type: string;
	hit_count: number;
	content: string;
	structured?: string;
	score?: number;
	saved_at?: string;
	enabled: boolean;
	project_name?: string;
}

export interface ActivityEntry {
	timestamp: string;
	action: string;
	target: string;
	detail?: string;
}

export interface KnowledgeStats {
	total: number;
	bySubType: Record<string, number>;
	avgHitCount: number;
}

export interface EpicSummary {
	slug: string;
	name: string;
	status: string;
	completed: number;
	total: number;
	tasks?: EpicTaskSummary[];
}

export interface EpicTaskSummary {
	slug: string;
	status: string;
}

export interface DecisionEntry {
	task_slug: string;
	title: string;
	chosen?: string;
	alternatives?: string;
	reason?: string;
}

export interface MemoryHealthStats {
	total: number;
	stale_count: number;
	conflict_count: number;
	vitality_dist: [number, number, number, number, number];
}

// --- spec/validate.go ---

export interface ValidationCheck {
	name: string;
	status: string;
	message: string;
}

export interface ValidationReport {
	task_slug: string;
	size: string;
	spec_type: string;
	checks: ValidationCheck[];
	summary: string;
}

// --- spec/confidence.go ---

export interface ConfidenceItem {
	section: string;
	score: number;
	source?: string;
	grounding?: string;
}

export interface ConfidenceSummary {
	avg: number;
	total_items: number;
	low_items: number;
	items?: ConfidenceItem[];
	low_confidence_warnings?: string[];
	grounding_distribution?: Record<string, number>;
	grounding_warnings?: string[];
}

// --- spec/review.go ---

export interface ReviewComment {
	file: string;
	line: number;
	body: string;
	resolved?: boolean;
}

export interface Review {
	timestamp: string;
	status: "approved" | "changes_requested";
	comments?: ReviewComment[];
	summary?: string;
}

export interface ReviewHistoryResponse {
	reviews: Review[];
}

// --- API response wrappers ---

export interface TasksResponse {
	active: string;
	tasks: TaskDetail[];
}

export interface SpecsResponse {
	specs: SpecEntry[];
}

export interface SpecContentResponse {
	content: string;
}

export interface KnowledgeResponse {
	entries: KnowledgeEntry[];
}

export interface KnowledgeSearchResponse {
	entries: KnowledgeEntry[];
	method: string;
	partial: boolean;
}

export interface ActivityResponse {
	entries: ActivityEntry[];
}

export interface EpicsResponse {
	epics: EpicSummary[];
}

export interface DecisionsResponse {
	decisions: DecisionEntry[];
}

export interface VersionResponse {
	version: string;
}

// --- Knowledge Graph ---

export interface GraphEdge {
	source: number;
	target: number;
	score: number;
}

export interface GraphEdgesResponse {
	edges: GraphEdge[];
	method: "vector" | "keyword";
	truncated: boolean;
}

// Task status color map (FR-18)
export const TASK_STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
	pending: { bg: "#e5e7eb", text: "#374151", label: "Pending" },
	"in-progress": { bg: "#dbeafe", text: "#1e40af", label: "In Progress" },
	review: { bg: "#fef3c7", text: "#92400e", label: "Review" },
	done: { bg: "#dcfce7", text: "#166534", label: "Done" },
	deferred: { bg: "#ede9fe", text: "#5b21b6", label: "Deferred" },
	cancelled: { bg: "#fecaca", text: "#991b1b", label: "Cancelled" },
	// Legacy compatibility
	active: { bg: "#dbeafe", text: "#1e40af", label: "Active" },
	completed: { bg: "#dcfce7", text: "#166534", label: "Done" },
} as const;

// Brand color map for sub_type badges (DEC-15)
export const SUB_TYPE_COLORS: Record<string, string> = {
	session: "#40513b",
	decision: "#628141",
	pattern: "#2d8b7a",
	rule: "#e67e22",
	snapshot: "#8b7d6b",
} as const;
