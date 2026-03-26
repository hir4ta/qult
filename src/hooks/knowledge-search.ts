/**
 * Knowledge search helper for hooks.
 * Wraps Voyage vector search. Fail-open: returns [] on error.
 */
import type { KnowledgeType } from "../types.js";

export interface SearchHit {
	title: string;
	content: string;
	type: KnowledgeType;
	score: number;
}

/**
 * Search knowledge DB via Voyage vector search.
 * Fail-open: returns [] on error (timeout, DB error, etc).
 */
export async function searchKnowledgeSafe(
	query: string,
	opts: { type?: KnowledgeType; limit?: number; minScore?: number } = {},
): Promise<SearchHit[]> {
	try {
		const { Embedder } = await import("../embedder/index.js");
		const { openDefaultCached } = await import("../store/index.js");
		const { searchKnowledge } = await import("../store/search.js");

		const emb = Embedder.create();
		const store = openDefaultCached();

		const results = await searchKnowledge(store, emb, query, {
			type: opts.type ?? "all",
			limit: opts.limit ?? 3,
			minScore: opts.minScore ?? 0.70,
			trackHits: true,
		});

		return results.map((r) => ({
			title: r.entry.title,
			content: r.entry.content,
			type: r.entry.type,
			score: r.score,
		}));
	} catch {
		return [];
	}
}

/**
 * Normalize error signature for better search matching.
 * Strips paths, line numbers, hex addresses, timestamps, UUIDs.
 */
export function normalizeErrorSignature(error: string): string {
	return error
		.replace(/(?:\/[\w.-]+)+\.\w+/g, "<path>")
		.replace(/:\d+:\d+/g, "")
		.replace(/\(\d+,\d+\)/g, "")
		.replace(/0x[0-9a-f]+/gi, "<addr>")
		.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*/g, "<time>")
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
}

/**
 * Format search hits as CONTEXT text for injection.
 */
export function formatSearchHits(hits: SearchHit[]): string {
	if (hits.length === 0) return "";

	return hits
		.map((h) => {
			try {
				const parsed = JSON.parse(h.content);
				if (h.type === "error_resolution") {
					return `Previously resolved: "${parsed.error_signature}" → ${parsed.resolution}`;
				}
				if (h.type === "fix_pattern") {
					return `Example: ${parsed.explanation}\nBad: ${parsed.bad}\nGood: ${parsed.good}`;
				}
				if (h.type === "convention") {
					return `Convention: ${parsed.pattern}`;
				}
			} catch {
				// content is not valid JSON, use raw
			}
			return `${h.title}: ${h.content.slice(0, 200)}`;
		})
		.join("\n\n");
}
