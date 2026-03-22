// API response types — single source of truth in src/api/schemas.ts.
// Only `import type` is used — Zod runtime code is NOT included in the frontend bundle.

export type {
	ActivityEntry,
	ActivityResponse,
	DecisionEntry,
	DecisionsResponse,
	HealthResponse,
	KnowledgeEntry,
	KnowledgeResponse,
	KnowledgeSearchResponse,
	KnowledgeStats,
	Review,
	ReviewComment,
	ReviewHistoryResponse,
	ReviewStatusResponse,
	SpecContentResponse,
	SpecEntry,
	SpecsResponse,
	StepItem,
	TaskDetail,
	TasksResponse,
	ValidationCheck,
	ValidationReport,
	VersionResponse,
	WaveInfo,
	BriefingResponse,
	HeatmapEntry,
	HeatmapResponse,
} from "@api-types";

// --- Cross-project types ---

export interface ProjectRecord {
	id: string;
	name: string;
	remote: string;
	path: string;
	branch: string;
	registeredAt: string;
	lastSeenAt: string;
	status: string;
}

export interface UnifiedSearchResult {
	id: number;
	source: "knowledge" | "spec";
	title: string;
	content: string;
	projectId: string;
	projectName: string;
	score: number;
	subType?: string;
	hitCount?: number;
	slug?: string;
	fileName?: string;
	specStatus?: string;
}

export interface SearchResponse {
	results: UnifiedSearchResult[];
	method: string;
	count: number;
}

// --- Frontend-only types (not in API responses) ---

export interface MemoryHealthStats {
	total: number;
	bySubType: Record<string, number>;
	stale_count?: number;
	conflict_count?: number;
	vitality_dist?: [number, number, number, number, number];
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
