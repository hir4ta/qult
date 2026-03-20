import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "./index.js";
import { detectProject } from "./project.js";

export interface ProjectRecord {
	id: string;
	name: string;
	remote: string;
	path: string;
	branch: string;
	registeredAt: string;
	lastSeenAt: string;
	status: "active" | "archived" | "missing";
	metadata: Record<string, unknown>;
}

interface RawProjectRow {
	id: string;
	name: string;
	remote: string;
	path: string;
	branch: string;
	registered_at: string;
	last_seen_at: string;
	status: string;
	metadata: string;
}

function mapRow(row: RawProjectRow): ProjectRecord {
	return {
		id: row.id,
		name: row.name,
		remote: row.remote,
		path: row.path,
		branch: row.branch,
		registeredAt: row.registered_at,
		lastSeenAt: row.last_seen_at,
		status: row.status as ProjectRecord["status"],
		metadata: JSON.parse(row.metadata || "{}"),
	};
}

// Process-level cache — hooks are short-lived, no TTL needed
const projectCache = new Map<string, ProjectRecord>();

const PROJECT_ID_FILE = ".project-id";

export function readProjectIdFile(projectPath: string): string | null {
	try {
		const filePath = join(projectPath, ".alfred", PROJECT_ID_FILE);
		return readFileSync(filePath, "utf-8").trim() || null;
	} catch {
		return null;
	}
}

export function writeProjectIdFile(projectPath: string, id: string): void {
	try {
		const alfredDir = join(projectPath, ".alfred");
		if (!existsSync(alfredDir)) mkdirSync(alfredDir, { recursive: true });
		writeFileSync(join(alfredDir, PROJECT_ID_FILE), id + "\n", "utf-8");
	} catch {
		// Non-fatal: .alfred/ may not be writable
	}
}

export function registerProject(store: Store, dirPath: string): ProjectRecord {
	// Cache hit
	const cached = projectCache.get(dirPath);
	if (cached) {
		// Update last_seen_at in DB (lightweight)
		const now = new Date().toISOString();
		store.db.prepare("UPDATE projects SET last_seen_at = ? WHERE id = ?").run(now, cached.id);
		cached.lastSeenAt = now;
		return cached;
	}

	const info = detectProject(dirPath);
	const now = new Date().toISOString();

	// 1. Check .alfred/.project-id file
	const fileId = readProjectIdFile(info.path);
	if (fileId) {
		const existing = store.db.prepare("SELECT * FROM projects WHERE id = ?").get(fileId) as RawProjectRow | undefined;
		if (existing) {
			store.db.prepare("UPDATE projects SET last_seen_at = ?, path = ?, status = 'active' WHERE id = ?").run(now, info.path, fileId);
			const record = mapRow({ ...existing, last_seen_at: now, path: info.path, status: "active" });
			projectCache.set(dirPath, record);
			return record;
		}
	}

	// 2. Check (remote, path) match
	const byRemotePath = store.db.prepare("SELECT * FROM projects WHERE remote = ? AND path = ?").get(info.remote, info.path) as RawProjectRow | undefined;
	if (byRemotePath) {
		store.db.prepare("UPDATE projects SET last_seen_at = ?, status = 'active' WHERE id = ?").run(now, byRemotePath.id);
		const record = mapRow({ ...byRemotePath, last_seen_at: now, status: "active" });
		projectCache.set(dirPath, record);
		writeProjectIdFile(info.path, record.id);
		return record;
	}

	// 3. Remote match + old path gone → directory move
	if (info.remote) {
		const byRemote = store.db.prepare("SELECT * FROM projects WHERE remote = ?").all(info.remote) as RawProjectRow[];
		for (const row of byRemote) {
			if (!existsSync(row.path)) {
				// Old path no longer exists — update to new location
				store.db.prepare("UPDATE projects SET path = ?, last_seen_at = ?, status = 'active', branch = ? WHERE id = ?").run(info.path, now, info.branch, row.id);
				// Update unique index: delete old + re-insert is handled by the UPDATE since (remote, path) changes
				const record = mapRow({ ...row, path: info.path, last_seen_at: now, status: "active", branch: info.branch });
				projectCache.set(dirPath, record);
				writeProjectIdFile(info.path, record.id);
				return record;
			}
			// Old path still exists — this is a different clone, continue to new registration
		}
	}

	// 4. New project registration
	const id = randomUUID();
	store.db.prepare(
		"INSERT INTO projects (id, name, remote, path, branch, registered_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(id, info.name, info.remote, info.path, info.branch, now, now);

	const record: ProjectRecord = {
		id,
		name: info.name,
		remote: info.remote,
		path: info.path,
		branch: info.branch,
		registeredAt: now,
		lastSeenAt: now,
		status: "active",
		metadata: {},
	};
	projectCache.set(dirPath, record);
	writeProjectIdFile(info.path, id);
	return record;
}

export function listProjects(
	store: Store,
	options?: { status?: string; limit?: number },
): ProjectRecord[] {
	const status = options?.status;
	const limit = Math.min(options?.limit ?? 100, 500);
	let sql = "SELECT * FROM projects";
	const params: unknown[] = [];
	if (status) {
		sql += " WHERE status = ?";
		params.push(status);
	}
	sql += " ORDER BY last_seen_at DESC LIMIT ?";
	params.push(limit);
	return (store.db.prepare(sql).all(...params) as RawProjectRow[]).map(mapRow);
}

export function getProject(store: Store, id: string): ProjectRecord | null {
	const row = store.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as RawProjectRow | undefined;
	return row ? mapRow(row) : null;
}

export function updateProject(
	store: Store,
	id: string,
	updates: Partial<Pick<ProjectRecord, "name" | "status">>,
): void {
	const sets: string[] = [];
	const params: unknown[] = [];
	if (updates.name !== undefined) {
		sets.push("name = ?");
		params.push(updates.name);
	}
	if (updates.status !== undefined) {
		sets.push("status = ?");
		params.push(updates.status);
	}
	if (sets.length === 0) return;
	params.push(id);
	store.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...params);
	// Invalidate cache
	for (const [key, val] of projectCache) {
		if (val.id === id) projectCache.delete(key);
	}
}

export function detectMissingProjects(store: Store): number {
	const active = store.db.prepare("SELECT id, path FROM projects WHERE status = 'active'").all() as Array<{ id: string; path: string }>;
	let count = 0;
	for (const row of active) {
		if (!existsSync(row.path)) {
			store.db.prepare("UPDATE projects SET status = 'missing' WHERE id = ?").run(row.id);
			count++;
		}
	}
	return count;
}

export function cleanupMissingProjects(store: Store): { deleted: number; projects: string[] } {
	const missing = store.db.prepare("SELECT id, name FROM projects WHERE status = 'missing'").all() as Array<{ id: string; name: string }>;
	const names: string[] = [];
	for (const row of missing) {
		// Delete knowledge, spec_index, embeddings for this project
		store.db.prepare("DELETE FROM embeddings WHERE source = 'knowledge' AND source_id IN (SELECT id FROM knowledge_index WHERE project_id = ?)").run(row.id);
		store.db.prepare("DELETE FROM embeddings WHERE source = 'spec' AND source_id IN (SELECT id FROM spec_index WHERE project_id = ?)").run(row.id);
		store.db.prepare("DELETE FROM knowledge_index WHERE project_id = ?").run(row.id);
		store.db.prepare("DELETE FROM spec_index WHERE project_id = ?").run(row.id);
		store.db.prepare("DELETE FROM projects WHERE id = ?").run(row.id);
		names.push(row.name);
	}
	return { deleted: names.length, projects: names };
}
