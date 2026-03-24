import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
	KnowledgeResponse,
	KnowledgeStats,
	ProjectRecord,
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

export const specHistoryQueryOptions = (slug: string, file: string, projectId?: string) =>
	queryOptions({
		queryKey: ["spec-history", slug, file, projectId],
		queryFn: () => fetchJSON<{ versions: { timestamp: string; size: number }[]; count: number }>(
			taskURLWithProject(slug, projectId, "specs", file, "history"),
		),
		staleTime: REF_STALE,
		enabled: !!slug && !!file,
	});

export const specVersionQueryOptions = (slug: string, file: string, version: string, projectId?: string) =>
	queryOptions({
		queryKey: ["spec-version", slug, file, version, projectId],
		queryFn: () => fetchJSON<{ content: string; version: string }>(
			taskURLWithProject(slug, projectId, "specs", file, "versions", version),
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

export async function promoteKnowledge(id: number): Promise<{ promoted: boolean; new_sub_type: string }> {
	const res = await fetch(`/api/knowledge/${id}/promote`, { method: "POST" });
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}


export const validationQueryOptions = (slug: string, projectId?: string) =>
	queryOptions({
		queryKey: ["validation", slug, projectId],
		queryFn: () => fetchJSON<ValidationReport>(taskURLWithProject(slug, projectId, "validation")),
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

// --- Mutations ---

export async function completeTask(slug: string, projectId?: string) {
	const res = await fetch(taskURLWithProject(slug, projectId, "complete"), {
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
		},
	});
}
