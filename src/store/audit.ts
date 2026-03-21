import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Store } from "./index.js";

export interface AuditLogRow {
	id: number;
	projectId: string;
	timestamp: string;
	event: string;
	actor: string;
	slug: string;
	action: string;
	detail: string;
}

interface RawAuditLogRow {
	id: number;
	project_id: string;
	timestamp: string;
	event: string;
	actor: string;
	slug: string;
	action: string;
	detail: string;
}

function mapAuditRow(r: RawAuditLogRow): AuditLogRow {
	return {
		id: r.id,
		projectId: r.project_id,
		timestamp: r.timestamp,
		event: r.event,
		actor: r.actor,
		slug: r.slug,
		action: r.action,
		detail: r.detail,
	};
}

export function insertAuditLog(store: Store, entry: Omit<AuditLogRow, "id">): void {
	store.db
		.prepare(`
			INSERT OR IGNORE INTO audit_log
			(project_id, timestamp, event, actor, slug, action, detail)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`)
		.run(
			entry.projectId,
			entry.timestamp,
			entry.event,
			entry.actor,
			entry.slug,
			entry.action,
			entry.detail,
		);
}

export function queryAuditLog(
	store: Store,
	opts?: {
		projectId?: string;
		actor?: string;
		since?: string;
		limit?: number;
		offset?: number;
	},
): { entries: AuditLogRow[]; total: number } {
	const limit = opts?.limit ?? 100;
	const offset = opts?.offset ?? 0;
	const conditions: string[] = [];
	const params: unknown[] = [];

	if (opts?.projectId) {
		conditions.push("a.project_id = ?");
		params.push(opts.projectId);
	}
	if (opts?.actor) {
		conditions.push("a.actor = ?");
		params.push(opts.actor);
	}
	if (opts?.since) {
		conditions.push("a.timestamp >= ?");
		params.push(opts.since);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	const countRow = store.db
		.prepare(`SELECT COUNT(*) as cnt FROM audit_log a ${where}`)
		.get(...params) as { cnt: number };

	const rows = store.db
		.prepare(`
			SELECT a.id, a.project_id, a.timestamp, a.event, a.actor, a.slug, a.action, a.detail
			FROM audit_log a
			${where}
			ORDER BY a.timestamp DESC
			LIMIT ? OFFSET ?
		`)
		.all(...params, limit, offset) as RawAuditLogRow[];

	return { entries: rows.map(mapAuditRow), total: countRow.cnt };
}

/**
 * Sync audit.jsonl → audit_log (watermark + UNIQUE dedup).
 * Maps jsonl fields: action→event, target→slug, user→actor.
 */
export async function syncAuditJsonl(
	store: Store,
	projectId: string,
	projectPath: string,
): Promise<{ imported: number; skipped: number }> {
	const jsonlPath = join(projectPath, ".alfred", "audit.jsonl");
	if (!existsSync(jsonlPath)) return { imported: 0, skipped: 0 };

	// Get watermark
	const watermarkRow = store.db
		.prepare("SELECT MAX(timestamp) as ts FROM audit_log WHERE project_id = ?")
		.get(projectId) as { ts: string | null } | undefined;
	const watermark = watermarkRow?.ts ?? "";

	// Check file size for initial limit
	const fileSize = statSync(jsonlPath).size;
	const isLargeFile = fileSize > 10 * 1024 * 1024; // >10MB

	const insertStmt = store.db.prepare(`
		INSERT OR IGNORE INTO audit_log
		(project_id, timestamp, event, actor, slug, action, detail)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);

	let imported = 0;
	let skipped = 0;
	const MAX_INITIAL = 10000;
	const lines: string[] = [];

	// Read file line by line
	const rl = createInterface({
		input: createReadStream(jsonlPath, { encoding: "utf-8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	for await (const line of rl) {
		if (!line.trim()) continue;
		lines.push(line);
	}

	// For large files on first sync, take only last N lines
	const toProcess = watermark === "" && isLargeFile
		? lines.slice(-MAX_INITIAL)
		: lines;

	const txn = store.db.transaction(() => {
		for (const line of toProcess) {
			try {
				const entry = JSON.parse(line) as {
					timestamp?: string;
					action?: string;
					target?: string;
					detail?: string;
					user?: string;
				};

				const ts = entry.timestamp ?? "";
				if (ts < watermark) {
					skipped++;
					continue;
				}

				const detail = entry.detail
					? (typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail))
					: "{}";
				insertStmt.run(
					projectId,
					ts,
					entry.action ?? "",       // jsonl.action → audit_log.event
					entry.user ?? "unknown",   // jsonl.user → audit_log.actor
					entry.target ?? "",        // jsonl.target → audit_log.slug
					"",                        // audit_log.action (sub-action, not in jsonl)
					detail,
				);
				imported++;
			} catch {
				skipped++;
			}
		}
	});
	txn();

	return { imported, skipped };
}

// ── Analytics ──

export function getKnowledgeHitRanking(
	store: Store,
	opts?: { projectId?: string; limit?: number },
): Array<{ id: number; title: string; hitCount: number; projectName: string }> {
	const limit = opts?.limit ?? 10;
	const projectFilter = opts?.projectId ? "AND ki.project_id = ?" : "";
	const params: unknown[] = opts?.projectId ? [opts.projectId, limit] : [limit];

	const rows = store.db
		.prepare(`
			SELECT ki.id, ki.title, ki.hit_count, p.name as project_name
			FROM knowledge_index ki
			JOIN projects p ON p.id = ki.project_id
			WHERE ki.enabled = 1 AND ki.hit_count > 0 ${projectFilter}
			ORDER BY ki.hit_count DESC
			LIMIT ?
		`)
		.all(...params) as Array<{ id: number; title: string; hit_count: number; project_name: string }>;

	return rows.map((r) => ({
		id: r.id,
		title: r.title,
		hitCount: r.hit_count,
		projectName: r.project_name,
	}));
}

export function getSpecCompletionStats(
	store: Store,
	opts?: { projectId?: string },
): Array<{ size: string; avgDays: number; count: number }> {
	const projectFilter = opts?.projectId ? "AND a1.project_id = ?" : "";
	const params: unknown[] = opts?.projectId ? [opts.projectId] : [];

	// Use audit_log to compute spec completion time:
	// earliest spec.init → latest spec.complete per slug (avoids cartesian on re-init)
	const rows = store.db
		.prepare(`
			SELECT
				inits.detail as init_detail,
				inits.init_ts,
				completes.complete_ts
			FROM (
				SELECT slug, project_id, MIN(timestamp) as init_ts, detail
				FROM audit_log WHERE event = 'spec.init' GROUP BY slug, project_id
			) inits
			JOIN (
				SELECT slug, project_id, MAX(timestamp) as complete_ts
				FROM audit_log WHERE event = 'spec.complete' GROUP BY slug, project_id
			) completes ON inits.slug = completes.slug AND inits.project_id = completes.project_id
			WHERE 1=1 ${projectFilter ? "AND inits.project_id = ?" : ""}
		`)
		.all(...params) as Array<{ init_detail: string; init_ts: string; complete_ts: string }>;

	// Group by size (parsed from init detail or default to 'M')
	const bySize = new Map<string, number[]>();
	for (const r of rows) {
		let size = "M";
		try {
			const detail = JSON.parse(r.init_detail);
			if (detail.size) size = detail.size;
		} catch { /* default M */ }

		const days = (new Date(r.complete_ts).getTime() - new Date(r.init_ts).getTime()) / (1000 * 60 * 60 * 24);
		if (days < 0) continue;

		const arr = bySize.get(size) ?? [];
		arr.push(days);
		bySize.set(size, arr);
	}

	return [...bySize.entries()].map(([size, durations]) => ({
		size,
		avgDays: Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10,
		count: durations.length,
	}));
}
