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
		queryFn: () => fetchJSON<SpecsResponse>(`/api/tasks/${slug}/specs`),
		staleTime: REF_STALE,
		enabled: !!slug,
	});

export const specContentQueryOptions = (slug: string, file: string) =>
	queryOptions({
		queryKey: ["spec-content", slug, file],
		queryFn: () => fetchJSON<SpecContentResponse>(`/api/tasks/${slug}/specs/${file}`),
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
		queryFn: () => fetchJSON<ConfidenceSummary>(`/api/tasks/${slug}/confidence`),
		staleTime: REF_STALE,
		enabled: !!slug,
	});

export const validationQueryOptions = (slug: string) =>
	queryOptions({
		queryKey: ["validation", slug],
		queryFn: () => fetchJSON<ValidationReport>(`/api/tasks/${slug}/validation`),
		staleTime: REF_STALE,
		enabled: !!slug,
	});

export const versionQueryOptions = () =>
	queryOptions({
		queryKey: ["version"],
		queryFn: () => fetchJSON<VersionResponse>("/api/version"),
		staleTime: REF_STALE,
	});

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
