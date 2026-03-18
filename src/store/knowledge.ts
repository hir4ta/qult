import { createHash } from "node:crypto";
import type { KnowledgeRow, KnowledgeStats } from "../types.js";
import type { Store } from "./index.js";

export function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

interface UpsertResult {
	id: number;
	changed: boolean;
}

export function upsertKnowledge(store: Store, row: KnowledgeRow): UpsertResult {
	const now = new Date().toISOString();
	if (!row.createdAt) row.createdAt = now;
	row.updatedAt = now;
	row.contentHash = contentHash(row.content);

	// Check if content unchanged.
	const existing = store.db
		.prepare(
			"SELECT id, content_hash FROM knowledge_index WHERE project_remote = ? AND project_path = ? AND file_path = ?",
		)
		.get(row.projectRemote, row.projectPath, row.filePath) as
		| { id: number; content_hash: string }
		| undefined;

	if (existing && existing.content_hash === row.contentHash) {
		row.id = existing.id;
		return { id: existing.id, changed: false };
	}

	const result = store.db
		.prepare(`
    INSERT INTO knowledge_index
    (file_path, content_hash, title, content, sub_type,
     project_remote, project_path, project_name, branch,
     created_at, updated_at, hit_count, last_accessed, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', 1)
    ON CONFLICT(project_remote, project_path, file_path) DO UPDATE SET
     content_hash = excluded.content_hash,
     title = excluded.title,
     content = excluded.content,
     sub_type = excluded.sub_type,
     project_name = excluded.project_name,
     branch = excluded.branch,
     updated_at = excluded.updated_at
  `)
		.run(
			row.filePath,
			row.contentHash,
			row.title,
			row.content,
			row.subType,
			row.projectRemote,
			row.projectPath,
			row.projectName,
			row.branch,
			row.createdAt,
			row.updatedAt,
		);

	const id = Number(result.lastInsertRowid);
	row.id = id;
	return { id, changed: true };
}

export function deleteKnowledge(store: Store, id: number): void {
	const txn = store.db.transaction(() => {
		store.db.prepare("DELETE FROM embeddings WHERE source = 'knowledge' AND source_id = ?").run(id);
		store.db.prepare("DELETE FROM knowledge_index WHERE id = ?").run(id);
	});
	txn();
}

export function deleteKnowledgeByProject(
	store: Store,
	projectRemote: string,
	projectPath: string,
): number {
	const txn = store.db.transaction(() => {
		store.db
			.prepare(`
      DELETE FROM embeddings WHERE source = 'knowledge' AND source_id IN
      (SELECT id FROM knowledge_index WHERE project_remote = ? AND project_path = ?)
    `)
			.run(projectRemote, projectPath);

		const result = store.db
			.prepare("DELETE FROM knowledge_index WHERE project_remote = ? AND project_path = ?")
			.run(projectRemote, projectPath);
		return result.changes;
	});
	return txn() as number;
}

export function getKnowledgeByID(store: Store, id: number): KnowledgeRow | undefined {
	const row = store.db
		.prepare(`
    SELECT id, file_path, content_hash, title, content, sub_type,
           project_remote, project_path, project_name, branch,
           created_at, updated_at, hit_count, last_accessed, enabled
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
    SELECT id, file_path, content_hash, title, content, sub_type,
           project_remote, project_path, project_name, branch,
           created_at, updated_at, hit_count, last_accessed, enabled
    FROM knowledge_index WHERE id IN (${placeholders})
  `)
		.all(...ids) as RawKnowledgeRow[];
	return rows.map(mapRow);
}

export function listKnowledge(
	store: Store,
	projectRemote: string,
	projectPath: string,
	limit: number,
): KnowledgeRow[] {
	const rows = store.db
		.prepare(`
    SELECT id, file_path, content_hash, title, content, sub_type,
           project_remote, project_path, project_name, branch,
           created_at, updated_at, hit_count, last_accessed, enabled
    FROM knowledge_index
    WHERE project_remote = ? AND project_path = ? AND enabled = 1
    ORDER BY updated_at DESC LIMIT ?
  `)
		.all(projectRemote, projectPath, limit) as RawKnowledgeRow[];
	return rows.map(mapRow);
}

export function listAllKnowledge(
	store: Store,
	projectRemote: string,
	projectPath: string,
	limit: number,
): KnowledgeRow[] {
	const rows = store.db
		.prepare(`
    SELECT id, file_path, content_hash, title, content, sub_type,
           project_remote, project_path, project_name, branch,
           created_at, updated_at, hit_count, last_accessed, enabled
    FROM knowledge_index
    WHERE project_remote = ? AND project_path = ?
    ORDER BY updated_at DESC LIMIT ?
  `)
		.all(projectRemote, projectPath, limit) as RawKnowledgeRow[];
	return rows.map(mapRow);
}

export function setKnowledgeEnabled(store: Store, id: number, enabled: boolean): void {
	store.db.prepare("UPDATE knowledge_index SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

export function incrementHitCount(store: Store, ids: number[]): void {
	if (ids.length === 0) return;
	const now = new Date().toISOString();
	const placeholders = ids.map(() => "?").join(",");
	store.db
		.prepare(
			`UPDATE knowledge_index SET hit_count = hit_count + 1, last_accessed = ?
     WHERE id IN (${placeholders})`,
		)
		.run(now, ...ids);
}

export function promoteSubType(store: Store, id: number, newSubType: string): void {
	const now = new Date().toISOString();
	const result = store.db
		.prepare("UPDATE knowledge_index SET sub_type = ?, updated_at = ? WHERE id = ? AND enabled = 1")
		.run(newSubType, now, id);
	if (result.changes === 0) {
		throw new Error(`store: promote sub_type: knowledge ${id} not found or disabled`);
	}
}

export function getPromotionCandidates(store: Store): KnowledgeRow[] {
	const rows = store.db
		.prepare(`
    SELECT id, file_path, content_hash, title, content, sub_type,
           project_remote, project_path, project_name, branch,
           created_at, updated_at, hit_count, last_accessed, enabled
    FROM knowledge_index
    WHERE enabled = 1
      AND (sub_type = 'pattern' AND hit_count >= 15)
    ORDER BY hit_count DESC
  `)
		.all() as RawKnowledgeRow[];
	return rows.map(mapRow);
}

export function getKnowledgeStats(store: Store): KnowledgeStats {
	const agg = store.db
		.prepare(
			"SELECT COUNT(*) as total, COALESCE(AVG(hit_count), 0) as avg_hits FROM knowledge_index WHERE enabled = 1",
		)
		.get() as { total: number; avg_hits: number } | undefined;

	const bySubType: Record<string, number> = {};
	const subtypeRows = store.db
		.prepare(
			"SELECT sub_type, COUNT(*) as cnt FROM knowledge_index WHERE enabled = 1 GROUP BY sub_type",
		)
		.all() as Array<{ sub_type: string; cnt: number }>;
	for (const r of subtypeRows) {
		bySubType[r.sub_type] = r.cnt;
	}

	const topRows = store.db
		.prepare(`
    SELECT id, file_path, content_hash, title, content, sub_type,
           project_remote, project_path, project_name, branch,
           created_at, updated_at, hit_count, last_accessed, enabled
    FROM knowledge_index WHERE enabled = 1
    ORDER BY hit_count DESC LIMIT 5
  `)
		.all() as RawKnowledgeRow[];

	return {
		total: agg?.total ?? 0,
		avgHitCount: agg?.avg_hits ?? 0,
		bySubType,
		topAccessed: topRows.map(mapRow),
	};
}

export function searchKnowledgeKeyword(store: Store, query: string, limit: number): KnowledgeRow[] {
	const escaped = escapeLIKEContains(query);
	const rows = store.db
		.prepare(`
    SELECT id, file_path, content_hash, title, content, sub_type,
           project_remote, project_path, project_name, branch,
           created_at, updated_at, hit_count, last_accessed, enabled
    FROM knowledge_index
    WHERE enabled = 1 AND (content LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')
    ORDER BY hit_count DESC LIMIT ?
  `)
		.all(escaped, escaped, limit) as RawKnowledgeRow[];
	return rows.map(mapRow);
}

export function getRecentDecisions(
	store: Store,
	projectRemote: string,
	projectPath: string,
	sinceISO: string,
	limit: number,
): Array<{ title: string; content: string; createdAt: string }> {
	const rows = store.db
		.prepare(`
    SELECT title, content, created_at FROM knowledge_index
    WHERE sub_type = 'decision'
      AND project_remote = ? AND project_path = ?
      AND created_at > ? AND enabled = 1
    ORDER BY created_at DESC LIMIT ?
  `)
		.all(projectRemote, projectPath, sinceISO, limit) as Array<{
		title: string;
		content: string;
		created_at: string;
	}>;
	return rows.map((r) => ({ title: r.title, content: r.content, createdAt: r.created_at }));
}

export function deleteOrphanKnowledge(
	store: Store,
	projectRemote: string,
	projectPath: string,
	branch: string,
	validFilePaths: Set<string>,
): number {
	const rows = store.db
		.prepare(
			"SELECT id, file_path FROM knowledge_index WHERE project_remote = ? AND project_path = ? AND branch = ?",
		)
		.all(projectRemote, projectPath, branch) as Array<{ id: number; file_path: string }>;

	let deleted = 0;
	const delEmbed = store.db.prepare("DELETE FROM embeddings WHERE source = 'knowledge' AND source_id = ?");
	const delKnowledge = store.db.prepare("DELETE FROM knowledge_index WHERE id = ?");
	const txn = store.db.transaction(() => {
		for (const row of rows) {
			if (!validFilePaths.has(row.file_path)) {
				delEmbed.run(row.id);
				delKnowledge.run(row.id);
				deleted++;
			}
		}
	});
	txn();
	return deleted;
}

export function countKnowledge(store: Store, projectRemote: string, projectPath: string): number {
	const row = store.db
		.prepare(
			"SELECT COUNT(*) as cnt FROM knowledge_index WHERE project_remote = ? AND project_path = ? AND enabled = 1",
		)
		.get(projectRemote, projectPath) as { cnt: number };
	return row.cnt;
}

function escapeLIKEContains(s: string): string {
	s = s.replaceAll("\\", "\\\\");
	s = s.replaceAll("%", "\\%");
	s = s.replaceAll("_", "\\_");
	return `%${s}%`;
}

export interface RawKnowledgeRow {
	id: number;
	file_path: string;
	content_hash: string;
	title: string;
	content: string;
	sub_type: string;
	project_remote: string;
	project_path: string;
	project_name: string;
	branch: string;
	created_at: string;
	updated_at: string;
	hit_count: number;
	last_accessed: string;
	enabled: number;
}

export function mapRow(r: RawKnowledgeRow): KnowledgeRow {
	return {
		id: r.id,
		filePath: r.file_path,
		contentHash: r.content_hash,
		title: r.title,
		content: r.content,
		subType: r.sub_type,
		projectRemote: r.project_remote,
		projectPath: r.project_path,
		projectName: r.project_name,
		branch: r.branch,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		hitCount: r.hit_count,
		lastAccessed: r.last_accessed,
		enabled: r.enabled === 1,
	};
}
