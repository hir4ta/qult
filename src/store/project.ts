import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import type { ProjectRecord } from "../types.js";
import type { Store } from "./index.js";

interface ProjectInfo {
	path: string;
	name: string;
	remote: string;
}

export function detectProject(dirPath: string): ProjectInfo {
	const absPath = resolve(dirPath);
	const info: ProjectInfo = {
		path: absPath,
		name: basename(absPath),
		remote: "",
	};

	info.remote = detectGitRemote(absPath);
	if (info.remote) {
		const name = repoNameFromRemote(info.remote);
		if (name) info.name = name;
	}

	return info;
}

export function resolveOrRegisterProject(store: Store, dirPath: string): ProjectRecord {
	const info = detectProject(dirPath);
	const now = new Date().toISOString();

	// Try path match first (primary key for local projects)
	const existing = store.db.prepare("SELECT * FROM projects WHERE path = ?").get(info.path) as
		| RawProjectRow
		| undefined;

	if (existing) {
		store.db
			.prepare("UPDATE projects SET last_seen_at = ?, status = 'active' WHERE id = ?")
			.run(now, existing.id);
		return mapProjectRow({ ...existing, last_seen_at: now, status: "active" });
	}

	// Try remote-only match (directory moved)
	if (info.remote) {
		const remoteMatch = store.db
			.prepare("SELECT * FROM projects WHERE remote = ? AND path != ?")
			.get(info.remote, info.path) as RawProjectRow | undefined;

		if (remoteMatch) {
			const oldPath = remoteMatch.path;
			store.db
				.prepare("UPDATE projects SET path = ?, last_seen_at = ?, status = 'active' WHERE id = ?")
				.run(info.path, now, remoteMatch.id);
			process.stderr.write(`alfred: project path updated: ${oldPath} → ${info.path}\n`);
			return mapProjectRow({
				...remoteMatch,
				path: info.path,
				last_seen_at: now,
				status: "active",
			});
		}
	}

	// New project — register with UUID
	const id = randomUUID();
	store.db
		.prepare(`
			INSERT INTO projects (id, name, remote, path, registered_at, last_seen_at, status)
			VALUES (?, ?, ?, ?, ?, ?, 'active')
		`)
		.run(id, info.name, info.remote, info.path, now, now);

	return {
		id,
		name: info.name,
		remote: info.remote,
		path: info.path,
		registeredAt: now,
		lastSeenAt: now,
		status: "active",
	};
}

export function getProject(store: Store, id: string): ProjectRecord | undefined {
	const row = store.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
		| RawProjectRow
		| undefined;
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

export function updateProjectStatus(
	store: Store,
	id: string,
	status: "active" | "archived" | "missing",
): void {
	store.db.prepare("UPDATE projects SET status = ? WHERE id = ?").run(status, id);
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

export function normalizeRemoteURL(raw: string): string {
	let s = raw;
	if (s.startsWith("git@")) {
		s = s.slice(4);
		s = s.replace(":", "/");
	}
	s = s.replace(/^https?:\/\//, "");
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
	registered_at: string;
	last_seen_at: string;
	status: string;
}

function mapProjectRow(r: RawProjectRow): ProjectRecord {
	return {
		id: r.id,
		name: r.name,
		remote: r.remote,
		path: r.path,
		registeredAt: r.registered_at,
		lastSeenAt: r.last_seen_at,
		status: r.status,
	};
}
