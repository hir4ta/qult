import type { KnowledgeConflict, KnowledgeRowV1 as KnowledgeRow } from "../types.js";
import type { Store } from "./index.js";
import type { RawKnowledgeRow } from "./knowledge.js";
import { getKnowledgeByIDs, mapRow, searchKnowledgeKeyword } from "./knowledge.js";
import { pairwiseSimilarity } from "./vectors.js";

export function subTypeHalfLife(subType: string): number {
	switch (subType) {
		case "assumption":
			return 30;
		case "inference":
			return 45;
		case "snapshot":
			return 30;
		case "pattern":
			return 90;
		case "decision":
			return 90;
		case "rule":
			return 120;
		default:
			return 60;
	}
}

export function subTypeBoost(subType: string): number {
	switch (subType) {
		case "rule":
			return 2.0;
		case "decision":
			return 1.5;
		case "pattern":
			return 1.3;
		default:
			return 1.0;
	}
}

export function searchKnowledgeFTS(store: Store, query: string, limit: number): KnowledgeRow[] {
	if (limit <= 0) limit = 10;
	query = query.trim();
	if (!query) return searchKnowledgeKeyword(store, "", limit);

	const words = query.split(/\s+/);
	let expanded: string[];
	try {
		expanded = expandAliases(store, words);
	} catch {
		expanded = words;
	}

	const ftsTerms: string[] = [];
	for (const w of expanded) {
		const sanitized = sanitizeFTSTerm(w);
		if (sanitized) ftsTerms.push(`"${sanitized}"`);
	}
	if (ftsTerms.length === 0) {
		return searchKnowledgeKeyword(store, query, limit);
	}
	const ftsQuery = ftsTerms.join(" OR ");

	let docs: KnowledgeRow[];
	try {
		docs = searchFTSKnowledge(store, ftsQuery, limit);
	} catch {
		return searchKnowledgeKeyword(store, query, limit);
	}

	if (docs.length < limit) {
		const fuzzyDocs = fuzzySearchKnowledge(store, words, limit - docs.length, docs);
		docs.push(...fuzzyDocs);
	}

	return docs;
}

function searchFTSKnowledge(store: Store, ftsQuery: string, limit: number): KnowledgeRow[] {
	const rows = store.db
		.prepare(`
    SELECT k.id, k.project_id, k.file_path, k.content_hash, k.title, k.content, k.sub_type,
      k.branch, k.created_at, k.updated_at, k.hit_count, k.last_accessed, k.enabled,
      bm25(knowledge_fts, 3.0, 1.0, 1.0) AS rank
    FROM knowledge_fts f
    JOIN knowledge_index k ON k.id = f.rowid
    WHERE knowledge_fts MATCH ? AND k.enabled = 1
    ORDER BY rank
    LIMIT ?
  `)
		.all(ftsQuery, limit) as Array<RawKnowledgeRow & { rank: number }>;

	return rows.map(mapRow);
}

// --- Unified search (knowledge + spec) ---

export type UnifiedSource = "knowledge" | "spec";

export interface UnifiedSearchResult {
	id: number;
	source: UnifiedSource;
	title: string;
	content: string;
	projectId: string;
	projectName: string;
	score: number;
	// knowledge-specific
	subType?: string;
	hitCount?: number;
	// spec-specific
	slug?: string;
	fileName?: string;
	specStatus?: string;
}

export function searchUnified(
	store: Store,
	query: string,
	options?: {
		sources?: UnifiedSource[];
		projectId?: string;
		limit?: number;
	},
): UnifiedSearchResult[] {
	const limit = options?.limit ?? 20;
	const sources = options?.sources ?? ["knowledge", "spec"];
	const projectId = options?.projectId;

	const q = query.trim();
	if (!q) return [];

	const words = q.split(/\s+/);
	let expanded: string[];
	try {
		expanded = expandAliases(store, words);
	} catch {
		expanded = words;
	}
	const ftsTerms: string[] = [];
	for (const w of expanded) {
		const sanitized = sanitizeFTSTerm(w);
		if (sanitized) ftsTerms.push(`"${sanitized}"`);
	}
	if (ftsTerms.length === 0) return [];
	const ftsQuery = ftsTerms.join(" OR ");

	const results: UnifiedSearchResult[] = [];

	if (sources.includes("knowledge")) {
		const projectFilter = projectId ? "AND k.project_id = ?" : "";
		const params: unknown[] = [ftsQuery];
		if (projectId) params.push(projectId);
		params.push(limit);

		try {
			const rows = store.db
				.prepare(`
        SELECT k.id, k.project_id, k.title, k.content, k.sub_type, k.hit_count,
               COALESCE(p.name, '') as project_name,
               bm25(knowledge_fts, 3.0, 1.0, 1.0) AS rank
        FROM knowledge_fts f
        JOIN knowledge_index k ON k.id = f.rowid
        LEFT JOIN projects p ON p.id = k.project_id
        WHERE knowledge_fts MATCH ? AND k.enabled = 1 ${projectFilter}
        ORDER BY rank
        LIMIT ?
      `)
				.all(...params) as Array<{
				id: number; project_id: string; title: string; content: string;
				sub_type: string; hit_count: number; project_name: string; rank: number;
			}>;

			for (const r of rows) {
				results.push({
					id: r.id, source: "knowledge", title: r.title, content: r.content,
					projectId: r.project_id, projectName: r.project_name,
					score: -r.rank, // BM25 rank is negative (lower = better)
					subType: r.sub_type, hitCount: r.hit_count,
				});
			}
		} catch (e) { process.stderr.write(`alfred: FTS knowledge search error: ${e}\n`); }
	}

	if (sources.includes("spec")) {
		const projectFilter = projectId ? "AND s.project_id = ?" : "";
		const params: unknown[] = [ftsQuery];
		if (projectId) params.push(projectId);
		params.push(limit);

		try {
			const rows = store.db
				.prepare(`
        SELECT s.id, s.project_id, s.title, s.content, s.slug, s.file_name, s.status,
               COALESCE(p.name, '') as project_name,
               bm25(spec_fts, 3.0, 1.0, 1.0) AS rank
        FROM spec_fts f
        JOIN spec_index s ON s.id = f.rowid
        LEFT JOIN projects p ON p.id = s.project_id
        WHERE spec_fts MATCH ? ${projectFilter}
        ORDER BY rank
        LIMIT ?
      `)
				.all(...params) as Array<{
				id: number; project_id: string; title: string; content: string;
				slug: string; file_name: string; status: string; project_name: string; rank: number;
			}>;

			for (const r of rows) {
				results.push({
					id: r.id, source: "spec", title: r.title, content: r.content,
					projectId: r.project_id, projectName: r.project_name,
					score: -r.rank,
					slug: r.slug, fileName: r.file_name, specStatus: r.status,
				});
			}
		} catch (e) { process.stderr.write(`alfred: FTS spec search error: ${e}\n`); }
	}

	// Sort by score descending, truncate
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, limit);
}

function fuzzySearchKnowledge(
	store: Store,
	queryWords: string[],
	limit: number,
	exclude: KnowledgeRow[],
): KnowledgeRow[] {
	if (limit <= 0) return [];
	const excludeIds = new Set(exclude.map((d) => d.id));

	const rows = store.db
		.prepare(`
    SELECT id, project_id, file_path, content_hash, title, content, sub_type,
           branch, created_at, updated_at, hit_count, last_accessed, enabled
    FROM knowledge_index WHERE enabled = 1 LIMIT 500
  `)
		.all() as RawKnowledgeRow[];

	const docs: KnowledgeRow[] = [];
	for (const r of rows) {
		if (excludeIds.has(r.id)) continue;

		const targetWords = r.title.toLowerCase().split(/\s+/);
		for (const qw of queryWords) {
			let matched = false;
			for (const tw of targetWords) {
				if (fuzzyMatch(qw, tw)) {
					matched = true;
					break;
				}
			}
			if (matched) {
				docs.push(mapRow(r));
				if (docs.length >= limit) return docs;
				break;
			}
		}
	}
	return docs;
}

export function detectKnowledgeConflicts(
	store: Store,
	threshold = 0.7,
	limit = 1000,
): KnowledgeConflict[] {
	const pairs = pairwiseSimilarity(store, { limit, minScore: threshold });

	const conflicts: KnowledgeConflict[] = [];
	for (const pair of pairs) {
		if (pair.score >= threshold) {
			conflicts.push({
				a: { id: pair.idA } as KnowledgeRow,
				b: { id: pair.idB } as KnowledgeRow,
				similarity: pair.score,
				type: "potential_duplicate",
			});
		}
	}

	if (conflicts.length > 0) {
		const allIds = conflicts.flatMap((c) => [c.a.id, c.b.id]);
		const hydrated = getKnowledgeByIDs(store, allIds);
		const docMap = new Map(hydrated.map((d) => [d.id, d]));
		for (const conflict of conflicts) {
			const a = docMap.get(conflict.a.id);
			const b = docMap.get(conflict.b.id);
			if (a) conflict.a = a;
			if (b) conflict.b = b;
			conflict.type = classifyConflict(conflict.a.content, conflict.b.content);
		}
	}

	conflicts.sort((a, b) => b.similarity - a.similarity);
	return conflicts;
}

export function expandAliases(store: Store, terms: string[]): string[] {
	if (terms.length === 0) return [];

	const seen = new Set(terms.map((t) => t.toLowerCase()));

	for (const t of terms) {
		const lower = t.toLowerCase();

		const aliasRows = store.db
			.prepare("SELECT alias FROM tag_aliases WHERE LOWER(tag) = ?")
			.all(lower) as Array<{ alias: string }>;
		for (const r of aliasRows) seen.add(r.alias.toLowerCase());

		const tagRows = store.db
			.prepare("SELECT tag FROM tag_aliases WHERE LOWER(alias) = ?")
			.all(lower) as Array<{ tag: string }>;
		for (const r of tagRows) seen.add(r.tag.toLowerCase());
	}

	return [...seen];
}

function sanitizeFTSTerm(term: string): string {
	return term.replace(/["*^{}]/g, "");
}

const CONTRADICTION_PAIRS: [string, string][] = [
	["always", "never"],
	["must", "must not"],
	["use", "avoid"],
	["enable", "disable"],
	["allow", "deny"],
	["required", "optional"],
	["do", "don't"],
	["add", "remove"],
	["include", "exclude"],
];

export function classifyConflict(
	contentA: string,
	contentB: string,
): "potential_duplicate" | "potential_contradiction" {
	const lowerA = contentA.toLowerCase();
	const lowerB = contentB.toLowerCase();

	for (const [w0, w1] of CONTRADICTION_PAIRS) {
		const aHas0 = lowerA.includes(w0);
		const aHas1 = lowerA.includes(w1);
		const bHas0 = lowerB.includes(w0);
		const bHas1 = lowerB.includes(w1);

		if ((aHas0 && bHas1 && !aHas1) || (aHas1 && bHas0 && !bHas1)) {
			return "potential_contradiction";
		}
	}
	return "potential_duplicate";
}

export function levenshtein(a: string, b: string): number {
	const ra = [...a];
	const rb = [...b];
	const la = ra.length;
	const lb = rb.length;

	if (la === 0) return lb;
	if (lb === 0) return la;

	let prev = Array.from({ length: lb + 1 }, (_, j) => j);

	for (let i = 1; i <= la; i++) {
		const curr = new Array<number>(lb + 1);
		curr[0] = i;
		for (let j = 1; j <= lb; j++) {
			const cost = ra[i - 1] === rb[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
		}
		prev = curr;
	}
	return prev[lb]!;
}

export function fuzzyMatch(query: string, target: string): boolean {
	const qLen = [...query].length;
	if (qLen < 3) return false;
	let maxDist = Math.min(2, Math.floor(qLen / 3));
	if (maxDist === 0) maxDist = 1;
	return levenshtein(query.toLowerCase(), target.toLowerCase()) <= maxDist;
}
