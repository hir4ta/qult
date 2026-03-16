import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	ActivityResponse,
	ConfidenceSummary,
	DecisionsResponse,
	EpicsResponse,
	KnowledgeResponse,
	KnowledgeSearchResponse,
	KnowledgeStats,
	MemoryHealthStats,
	Review,
	ReviewHistoryResponse,
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

// --- Query options (composable) ---

export const tasksQueryOptions = () =>
	queryOptions({
		queryKey: ["tasks"],
		queryFn: () => fetchJSON<TasksResponse>("/api/tasks"),
		staleTime: LIVE_STALE,
	});

export const specsQueryOptions = (slug: string) =>
	queryOptions({
		queryKey: ["specs", slug],
		queryFn: () => fetchJSON<SpecsResponse>(taskURL(slug, "specs")),
		staleTime: REF_STALE,
		enabled: !!slug,
	});

export const specContentQueryOptions = (slug: string, file: string) =>
	queryOptions({
		queryKey: ["spec-content", slug, file],
		queryFn: () => fetchJSON<SpecContentResponse>(taskURL(slug, "specs", file)),
		staleTime: REF_STALE,
		enabled: !!slug && !!file,
	});

export const knowledgeQueryOptions = (limit = 50) =>
	queryOptions({
		queryKey: ["knowledge", limit],
		queryFn: () => fetchJSON<KnowledgeResponse>(`/api/knowledge?limit=${limit}`),
		staleTime: LIVE_STALE,
	});

export const knowledgeStatsQueryOptions = () =>
	queryOptions({
		queryKey: ["knowledge-stats"],
		queryFn: () => fetchJSON<KnowledgeStats>("/api/knowledge/stats"),
		staleTime: REF_STALE,
	});

export const knowledgeSearchQueryOptions = (query: string, limit = 10) =>
	queryOptions({
		queryKey: ["knowledge-search", query],
		queryFn: () =>
			fetchJSON<KnowledgeSearchResponse>(
				`/api/knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}`,
			),
		staleTime: REF_STALE,
		enabled: query.length > 0,
	});

export const activityQueryOptions = (limit = 50, filter?: string) =>
	queryOptions({
		queryKey: ["activity", limit, filter],
		queryFn: () => {
			const params = new URLSearchParams({ limit: String(limit) });
			if (filter) params.set("filter", filter);
			return fetchJSON<ActivityResponse>(`/api/activity?${params}`);
		},
		staleTime: LIVE_STALE,
	});

export const epicsQueryOptions = () =>
	queryOptions({
		queryKey: ["epics"],
		queryFn: () => fetchJSON<EpicsResponse>("/api/epics"),
		staleTime: LIVE_STALE,
	});

export const decisionsQueryOptions = (limit = 20) =>
	queryOptions({
		queryKey: ["decisions", limit],
		queryFn: () => fetchJSON<DecisionsResponse>(`/api/decisions?limit=${limit}`),
		staleTime: LIVE_STALE,
	});

export const healthQueryOptions = () =>
	queryOptions({
		queryKey: ["health"],
		queryFn: () => fetchJSON<MemoryHealthStats>("/api/health"),
		staleTime: REF_STALE,
	});

export const confidenceQueryOptions = (slug: string) =>
	queryOptions({
		queryKey: ["confidence", slug],
		queryFn: () => fetchJSON<ConfidenceSummary>(taskURL(slug, "confidence")),
		staleTime: REF_STALE,
		enabled: !!slug,
	});

export const validationQueryOptions = (slug: string) =>
	queryOptions({
		queryKey: ["validation", slug],
		queryFn: () => fetchJSON<ValidationReport>(taskURL(slug, "validation")),
		staleTime: REF_STALE,
		enabled: !!slug,
	});

export const reviewQueryOptions = (slug: string) =>
	queryOptions({
		queryKey: ["review", slug],
		queryFn: () => fetchJSON<Review>(taskURL(slug, "review")),
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

export const versionQueryOptions = () =>
	queryOptions({
		queryKey: ["version"],
		queryFn: () => fetchJSON<VersionResponse>("/api/version"),
		staleTime: REF_STALE,
	});

// --- Mutations ---

export async function submitReview(
	slug: string,
	status: "approved" | "changes_requested",
	comments: { file: string; line: number; body: string }[],
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
