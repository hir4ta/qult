import type { QueryClient } from "@tanstack/react-query";

function safeParse<T>(data: string): T | null {
	try {
		return JSON.parse(data) as T;
	} catch {
		return null;
	}
}

export function setupSSE(queryClient: QueryClient): () => void {
	const es = new EventSource("/api/events");

	es.addEventListener("task_updated", () => {
		queryClient.invalidateQueries({ queryKey: ["tasks"] });
	});

	es.addEventListener("review_submitted", (e) => {
		const data = safeParse<{ slug: string }>(e.data);
		if (!data) return;
		queryClient.invalidateQueries({ queryKey: ["review", data.slug] });
		queryClient.invalidateQueries({ queryKey: ["tasks"] });
	});

	es.addEventListener("validation_changed", (e) => {
		const data = safeParse<{ slug: string }>(e.data);
		if (!data) return;
		queryClient.invalidateQueries({ queryKey: ["validation", data.slug] });
	});

	es.addEventListener("memory_changed", () => {
		queryClient.invalidateQueries({ queryKey: ["knowledge"] });
		queryClient.invalidateQueries({ queryKey: ["health"] });
	});

	es.addEventListener("activity_new", () => {
		queryClient.invalidateQueries({ queryKey: ["activity"] });
	});

	es.addEventListener("spec_changed", () => {
		queryClient.invalidateQueries({ queryKey: ["specs"] });
		queryClient.invalidateQueries({ queryKey: ["spec-content"] });
		queryClient.invalidateQueries({ queryKey: ["tasks"] });
	});

	es.onerror = () => {
		if (es.readyState === EventSource.CLOSED) {
			console.warn("[sse] connection closed, will not auto-reconnect");
		}
	};

	return () => es.close();
}
