import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	DecisionsResponse,
	KnowledgeEntry,
	KnowledgeResponse,
	KnowledgeStats,
	ProjectRecord,
	ReviewHistoryResponse,
	ReviewStatusResponse,
	SearchResponse,
	SpecContentResponse,
	SpecsResponse,
	TasksResponse,
	ValidationReport,
	VersionResponse,
} from "./types";

const LIVE_STALE = 5_000;
const REF_STALE = 60_000;

async function fetchJSON<T>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: res.statusText }));
		throw new Error(body.error ?? `HTTP ${res.status}`);
	}
	return res.json() as Promise<T>;
}

function taskURL(slug: string, ...segments: string[]): string {
	const parts = ["/api/tasks", encodeURIComponent(slug), ...segments.map(encodeURIComponent)];
	return parts.join("/");
}

function taskURLWithProject(slug: string, projectId: string | undefined, ...segments: string[]): string {
	const base = taskURL(slug, ...segments);
	return projectId ? `${base}?project=${projectId}` : base;
}

// --- Query options (composable) ---

export const tasksQueryOptions = (projectId?: string) =>
	queryOptions({
		queryKey: ["tasks", projectId],
		queryFn: () => {
			const url = projectId ? `/api/tasks?project=${projectId}` : "/api/tasks";
			return fetchJSON<TasksResponse>(url);
		},
		staleTime: LIVE_STALE,
	});

export const specsQueryOptions = (slug: string, projectId?: string) =>
	queryOptions({
		queryKey: ["specs", slug, projectId],
		queryFn: () => fetchJSON<SpecsResponse>(taskURLWithProject(slug, projectId, "specs")),
		staleTime: REF_STALE,
		enabled: !!slug,
	});

export const specContentQueryOptions = (slug: string, file: string, projectId?: string) =>
	queryOptions({
		queryKey: ["spec-content", slug, file, projectId],
		queryFn: () => fetchJSON<SpecContentResponse>(taskURLWithProject(slug, projectId, "specs", file)),
		staleTime: REF_STALE,
		enabled: !!slug && !!file,
	});

export const specHistoryQueryOptions = (slug: string, file: string) =>
	queryOptions({
		queryKey: ["spec-history", slug, file],
		queryFn: () => fetchJSON<{ versions: { timestamp: string; size: number }[]; count: number }>(
			taskURL(slug, "specs", file, "history"),
		),
		staleTime: REF_STALE,
		enabled: !!slug && !!file,
	});

export const specVersionQueryOptions = (slug: string, file: string, version: string) =>
	queryOptions({
		queryKey: ["spec-version", slug, file, version],
		queryFn: () => fetchJSON<{ content: string; version: string }>(
			taskURL(slug, "specs", file, "versions", version),
		),
		staleTime: REF_STALE,
		enabled: !!slug && !!file && !!version,
	});

export const knowledgeQueryOptions = (limit = 50, projectId?: string) =>
	queryOptions({
		queryKey: ["knowledge", limit, projectId],
		queryFn: () => {
			const params = new URLSearchParams({ limit: String(limit) });
			if (projectId) params.set("project", projectId);
			return fetchJSON<KnowledgeResponse>(`/api/knowledge?${params}`);
		},
		staleTime: LIVE_STALE,
	});

export const knowledgeStatsQueryOptions = (projectId?: string) =>
	queryOptions({
		queryKey: ["knowledge-stats", projectId],
		queryFn: () => {
			const url = projectId ? `/api/knowledge/stats?project=${projectId}` : "/api/knowledge/stats";
			return fetchJSON<KnowledgeStats>(url);
		},
		staleTime: REF_STALE,
	});

export const knowledgeCandidatesQueryOptions = () =>
	queryOptions({
		queryKey: ["knowledge-candidates"],
		queryFn: () => fetchJSON<{ candidates: KnowledgeEntry[] }>("/api/knowledge/candidates"),
		staleTime: REF_STALE,
	});

export async function promoteKnowledge(id: number): Promise<{ promoted: boolean; new_sub_type: string }> {
	const res = await fetch(`/api/knowledge/${id}/promote`, { method: "POST" });
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}


export const decisionsQueryOptions = (limit = 20, projectId?: string) =>
	queryOptions({
		queryKey: ["decisions", limit, projectId],
		queryFn: () => {
			const params = new URLSearchParams({ limit: String(limit) });
			if (projectId) params.set("project", projectId);
			return fetchJSON<DecisionsResponse>(`/api/decisions?${params}`);
		},
		staleTime: LIVE_STALE,
	});


export const validationQueryOptions = (slug: string, projectId?: string) =>
	queryOptions({
		queryKey: ["validation", slug, projectId],
		queryFn: () => fetchJSON<ValidationReport>(taskURLWithProject(slug, projectId, "validation")),
		staleTime: REF_STALE,
		enabled: !!slug,
	});

export const reviewQueryOptions = (slug: string) =>
	queryOptions({
		queryKey: ["review", slug],
		queryFn: () => fetchJSON<ReviewStatusResponse>(taskURL(slug, "review")),
		staleTime: REF_STALE,
		enabled: !!slug,
	});

export const reviewHistoryQueryOptions = (slug: string) =>
	queryOptions({
		queryKey: ["review-history", slug],
		queryFn: () => fetchJSON<ReviewHistoryResponse>(`${taskURL(slug, "review")}/history`),
		staleTime: REF_STALE,
		enabled: !!slug,
	});

export const projectsQueryOptions = () =>
	queryOptions({
		queryKey: ["projects"],
		queryFn: () => fetchJSON<{ projects: ProjectRecord[] }>("/api/projects"),
		staleTime: REF_STALE,
	});

export const searchQueryOptions = (query: string, opts?: { scope?: string; projectId?: string }) =>
	queryOptions({
		queryKey: ["search", query, opts?.scope, opts?.projectId],
		queryFn: () => {
			const params = new URLSearchParams({ q: query });
			if (opts?.scope) params.set("scope", opts.scope);
			if (opts?.projectId) params.set("project", opts.projectId);
			return fetchJSON<SearchResponse>(`/api/search?${params}`);
		},
		staleTime: LIVE_STALE,
		enabled: !!query,
	});

export const versionQueryOptions = () =>
	queryOptions({
		queryKey: ["version"],
		queryFn: () => fetchJSON<VersionResponse>("/api/version"),
		staleTime: REF_STALE,
	});

// --- Briefing ---

export interface BriefingResponse {
	activeSpecs: Array<{ slug: string; currentWave: number; totalWaves: number; remainingTasks: number }>;
	completedToday: number;
	knowledgeTotal: number;
	overdueVerifications: number;
	recentCompletions: Array<{ slug: string; completedAt: string }>;
}

export const briefingQueryOptions = (projectId?: string) =>
	queryOptions({
		queryKey: ["briefing", projectId],
		queryFn: () => {
			const url = projectId ? `/api/briefing?project=${projectId}` : "/api/briefing";
			return fetchJSON<BriefingResponse>(url);
		},
		staleTime: LIVE_STALE,
	});

// --- Activity / Analytics ---

export interface AnalyticsResponse {
	hitRanking: Array<{ id: number; title: string; hitCount: number; projectName: string }>;
	completionStats: Array<{ size: string; avgDays: number; count: number }>;
	reworkRates: Array<{
		slug: string; size: string; completedAt: string;
		reworkRate: number; reworkedCount: number; totalCount: number; pending: boolean;
	}>;
	cycleTimeBreakdown: Array<{
		slug: string; size: string;
		phases: { planning: number | null; approvalWait: number | null; implementation: number | null; total: number };
	}>;
}

export interface ActivityLogEntry {
	timestamp: string;
	action: string;
	target: string;
	detail: string;
	actor: string;
	project_name?: string;
}

export const analyticsQueryOptions = (projectId?: string) =>
	queryOptions({
		queryKey: ["analytics", projectId],
		queryFn: () => {
			const url = projectId ? `/api/activity/analytics?project=${projectId}` : "/api/activity/analytics";
			return fetchJSON<AnalyticsResponse>(url);
		},
		staleTime: REF_STALE,
	});

export interface KnowledgeGapEntry {
	query: string;
	intent: string;
	best_score: number;
	result_count: number;
	timestamp: string;
	spec_slug?: string;
}

export const knowledgeGapsQueryOptions = (projectId?: string) =>
	queryOptions({
		queryKey: ["knowledge-gaps", projectId],
		queryFn: () => {
			const url = projectId ? `/api/knowledge/gaps?project=${projectId}` : "/api/knowledge/gaps";
			return fetchJSON<{ entries: KnowledgeGapEntry[]; total: number }>(url);
		},
		staleTime: REF_STALE,
	});

export const activityQueryOptions = (page = 0, projectId?: string) =>
	queryOptions({
		queryKey: ["activity", page, projectId],
		queryFn: () => {
			const params = new URLSearchParams({ limit: "50", offset: String(page * 50) });
			if (projectId) params.set("project", projectId);
			return fetchJSON<{ entries: ActivityLogEntry[]; total: number }>(`/api/activity?${params}`);
		},
		staleTime: LIVE_STALE,
	});

// --- Mutations ---

export async function submitReview(
	slug: string,
	status: "approved" | "changes_requested",
	comments: { file: string; line: number; body: string; endLine?: number }[],
) {
	const res = await fetch(taskURL(slug, "review"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status, comments }),
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: res.statusText }));
		throw new Error(body.error ?? `HTTP ${res.status}`);
	}
	return res.json();
}

export async function completeTask(slug: string) {
	const res = await fetch(taskURL(slug, "complete"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: res.statusText }));
		throw new Error(body.error ?? `HTTP ${res.status}`);
	}
	return res.json();
}

// --- Hooks (convenience wrappers) ---

export function useTasksQuery() {
	return useQuery(tasksQueryOptions());
}

export function useToggleEnabledMutation() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({ id, enabled }: { id: number; enabled: boolean }) => {
			const res = await fetch(`/api/knowledge/${id}/enabled`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled }),
			});
			if (!res.ok) throw new Error("Failed to toggle enabled");
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["knowledge"] });
			queryClient.invalidateQueries({ queryKey: ["health"] });
		},
	});
}
