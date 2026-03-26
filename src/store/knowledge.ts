import type { KnowledgeRow, KnowledgeType } from "../types.js";
import type { Store } from "./index.js";

// ===== Raw DB Row =====

export interface RawKnowledgeRow {
	id: number;
	project_id: string;
	type: string;
	title: string;
	content: string;
	tags: string;
	author: string;
	hit_count: number;
	last_accessed: string;
	enabled: number;
	success_count: number;
	failure_count: number;
	utility_score: number;
	confidence: number;
	source: string;
	created_at: string;
	updated_at: string;
}

export function mapRow(r: RawKnowledgeRow): KnowledgeRow {
	return {
		id: r.id,
		projectId: r.project_id,
		type: r.type as KnowledgeType,
		title: r.title,
		content: r.content,
		tags: r.tags,
		author: r.author,
		hitCount: r.hit_count,
		lastAccessed: r.last_accessed,
		enabled: r.enabled === 1,
		successCount: r.success_count ?? 0,
		failureCount: r.failure_count ?? 0,
		utilityScore: r.utility_score ?? 0.5,
		confidence: r.confidence ?? 0.5,
		source: r.source ?? "",
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

// ===== CRUD =====

interface UpsertResult {
	id: number;
	changed: boolean;
}

export function upsertKnowledge(
	store: Store,
	row: {
		projectId: string;
		type: KnowledgeType;
		title: string;
		content: string;
		tags?: string;
		author?: string;
		source?: string;
	},
): UpsertResult {
	const now = new Date().toISOString();

	const existing = store.db
		.prepare(
			"SELECT id, content FROM knowledge_index WHERE project_id = ? AND type = ? AND title = ?",
		)
		.get(row.projectId, row.type, row.title) as { id: number; content: string } | undefined;

	if (existing && existing.content === row.content) {
		return { id: existing.id, changed: false };
	}

	const result = store.db
		.prepare(`
			INSERT INTO knowledge_index (project_id, type, title, content, tags, author, source, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(project_id, type, title) DO UPDATE SET
				content = excluded.content,
				tags = excluded.tags,
				source = excluded.source,
				updated_at = excluded.updated_at
		`)
		.run(
			row.projectId,
			row.type,
			row.title,
			row.content,
			row.tags ?? "",
			row.author ?? "",
			row.source ?? "auto",
			now,
			now,
		);

	const id = existing?.id ?? Number(result.lastInsertRowid);

	// Supersession: content changed → reset utility counters
	if (existing) {
		store.db
			.prepare(
				"UPDATE knowledge_index SET success_count = 0, failure_count = 0, utility_score = 0.5 WHERE id = ?",
			)
			.run(id);
	}

	return { id, changed: true };
}

export function getKnowledgeByID(store: Store, id: number): KnowledgeRow | undefined {
	const row = store.db
		.prepare(`
			SELECT id, project_id, type, title, content, tags, author,
			       hit_count, last_accessed, enabled,
			       success_count, failure_count, utility_score, confidence, source,
			       created_at, updated_at
			FROM knowledge_index WHERE id = ?
		`)
		.get(id) as RawKnowledgeRow | undefined;
	return row ? mapRow(row) : undefined;
}

export function getKnowledgeByIDs(store: Store, ids: number[]): KnowledgeRow[] {
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => "?").join(",");
	const rows = store.db
		.prepare(`
			SELECT id, project_id, type, title, content, tags, author,
			       hit_count, last_accessed, enabled,
			       success_count, failure_count, utility_score, confidence, source,
			       created_at, updated_at
			FROM knowledge_index WHERE id IN (${placeholders})
		`)
		.all(...ids) as RawKnowledgeRow[];
	return rows.map(mapRow);
}

export function listKnowledge(
	store: Store,
	opts?: { projectId?: string; type?: KnowledgeType; limit?: number; includeDisabled?: boolean },
): KnowledgeRow[] {
	const limit = opts?.limit ?? 50;
	const conditions: string[] = ["1=1"];
	const params: unknown[] = [];

	if (!opts?.includeDisabled) conditions.push("enabled = 1");
	if (opts?.projectId) {
		conditions.push("project_id = ?");
		params.push(opts.projectId);
	}
	if (opts?.type) {
		conditions.push("type = ?");
		params.push(opts.type);
	}
	params.push(limit);

	const rows = store.db
		.prepare(`
			SELECT id, project_id, type, title, content, tags, author,
			       hit_count, last_accessed, enabled,
			       success_count, failure_count, utility_score, confidence, source,
			       created_at, updated_at
			FROM knowledge_index WHERE ${conditions.join(" AND ")}
			ORDER BY updated_at DESC LIMIT ?
		`)
		.all(...params) as RawKnowledgeRow[];
	return rows.map(mapRow);
}

export function deleteKnowledge(store: Store, id: number): void {
	const txn = store.db.transaction(() => {
		store.db.prepare("DELETE FROM embeddings WHERE source = 'knowledge' AND source_id = ?").run(id);
		store.db.prepare("DELETE FROM knowledge_index WHERE id = ?").run(id);
	});
	txn();
}

export function incrementHitCount(store: Store, ids: number[]): void {
	if (ids.length === 0) return;
	const now = new Date().toISOString();
	const placeholders = ids.map(() => "?").join(",");
	store.db
		.prepare(
			`UPDATE knowledge_index SET hit_count = hit_count + 1, last_accessed = ? WHERE id IN (${placeholders})`,
		)
		.run(now, ...ids);
}

export function setKnowledgeEnabled(store: Store, id: number, enabled: boolean): void {
	store.db.prepare("UPDATE knowledge_index SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

export function countKnowledge(store: Store, projectId: string): number {
	const row = store.db
		.prepare("SELECT COUNT(*) as cnt FROM knowledge_index WHERE project_id = ? AND enabled = 1")
		.get(projectId) as { cnt: number };
	return row.cnt;
}
