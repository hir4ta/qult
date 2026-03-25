import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import type { ProjectInfo, ProjectRecord } from "../types.js";
// Note: ProjectRecord v2 doesn't have 'branch' but store code still references it.
// Will be cleaned up in Phase 1 store rewrite.
import type { Store } from "./index.js";

export function detectProject(dirPath: string): ProjectInfo {
	const absPath = resolve(dirPath);
	const info: ProjectInfo = {
		path: absPath,
		name: basename(absPath),
		remote: "",
		branch: "",
	};

	info.remote = detectGitRemote(absPath);
	info.branch = detectGitBranch(absPath);

	if (info.remote) {
		const name = repoNameFromRemote(info.remote);
		if (name) info.name = name;
	}

	return info;
}

export function resolveOrRegisterProject(store: Store, dirPath: string): ProjectRecord {
	const info = detectProject(dirPath);
	const now = new Date().toISOString();

	// Try exact match (remote + path)
	const existing = store.db
		.prepare("SELECT * FROM projects WHERE remote = ? AND path = ?")
		.get(info.remote, info.path) as RawProjectRow | undefined;

	if (existing) {
		store.db
			.prepare("UPDATE projects SET last_seen_at = ?, branch = ?, status = 'active' WHERE id = ?")
			.run(now, info.branch, existing.id);
		return mapProjectRow({ ...existing, last_seen_at: now, branch: info.branch, status: "active" });
	}

	// Try remote-only match (directory moved)
	if (info.remote) {
		const remoteMatch = store.db
			.prepare("SELECT * FROM projects WHERE remote = ? AND path != ?")
			.get(info.remote, info.path) as RawProjectRow | undefined;

		if (remoteMatch) {
			const oldPath = remoteMatch.path;
			store.db
				.prepare("UPDATE projects SET path = ?, last_seen_at = ?, branch = ?, status = 'active' WHERE id = ?")
				.run(info.path, now, info.branch, remoteMatch.id);
			process.stderr.write(`alfred: project path updated: ${oldPath} → ${info.path}\n`);
			return mapProjectRow({ ...remoteMatch, path: info.path, last_seen_at: now, branch: info.branch, status: "active" });
		}
	}

	// New project — register with UUID
	const id = randomUUID();
	store.db
		.prepare(`
			INSERT INTO projects (id, name, remote, path, branch, registered_at, last_seen_at, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
		`)
		.run(id, info.name, info.remote, info.path, info.branch, now, now);

	return {
		id,
		name: info.name,
		remote: info.remote,
		path: info.path,
		branch: info.branch,
		registeredAt: now,
		lastSeenAt: now,
		status: "active",
		metadata: "{}",
	};
}

export function getProject(store: Store, id: string): ProjectRecord | undefined {
	const row = store.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as RawProjectRow | undefined;
	return row ? mapProjectRow(row) : undefined;
}

export function listProjects(store: Store): ProjectRecord[] {
	const rows = store.db
		.prepare("SELECT * FROM projects ORDER BY last_seen_at DESC")
		.all() as RawProjectRow[];
	return rows.map(mapProjectRow);
}

export function listActiveProjects(store: Store): ProjectRecord[] {
	const rows = store.db
		.prepare("SELECT * FROM projects WHERE status = 'active' ORDER BY last_seen_at DESC")
		.all() as RawProjectRow[];
	return rows.map(mapProjectRow);
}

export function updateProjectStatus(store: Store, id: string, status: "active" | "archived" | "missing"): void {
	store.db.prepare("UPDATE projects SET status = ? WHERE id = ?").run(status, id);
}

export function renameProject(store: Store, id: string, name: string): void {
	store.db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
}

export function resolveProjectId(store: Store, remote: string, path: string): string | undefined {
	const row = store.db
		.prepare("SELECT id FROM projects WHERE remote = ? AND path = ?")
		.get(remote, path) as { id: string } | undefined;
	return row?.id;
}

// --- Git helpers ---

function detectGitRemote(dir: string): string {
	try {
		const out = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
			timeout: 500,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return normalizeRemoteURL(out.trim());
	} catch {
		return "";
	}
}

function detectGitBranch(dir: string): string {
	try {
		const out = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
			timeout: 500,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.trim();
	} catch {
		return "";
	}
}

export function normalizeRemoteURL(raw: string): string {
	let s = raw;

	// SSH format: git@github.com:user/repo.git
	if (s.startsWith("git@")) {
		s = s.slice(4);
		s = s.replace(":", "/");
	}

	// HTTPS format
	s = s.replace(/^https?:\/\//, "");

	// Remove .git suffix and trailing slash
	s = s.replace(/\.git$/, "");
	s = s.replace(/\/$/, "");

	return s;
}

function repoNameFromRemote(remote: string): string {
	const parts = remote.split("/");
	return parts[parts.length - 1] ?? "";
}

// --- Raw row mapping ---

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

function mapProjectRow(r: RawProjectRow): ProjectRecord {
	return {
		id: r.id,
		name: r.name,
		remote: r.remote,
		path: r.path,
		branch: r.branch,
		registeredAt: r.registered_at,
		lastSeenAt: r.last_seen_at,
		status: r.status,
		metadata: r.metadata ?? "{}",
	};
}
