import { getDb, getProjectId, getSessionId } from "./db.ts";

export interface AuditEntry {
	action: string;
	reason: string;
	gate_name?: string;
	timestamp: string;
}

const MAX_ENTRIES = 200;

/** Append an entry to the audit log. Fail-open: silently swallows errors. */
export function appendAuditLog(entry: AuditEntry): void {
	try {
		const db = getDb();
		const projectId = getProjectId();
		const sid = getSessionId();

		db.prepare(
			"INSERT INTO audit_log (project_id, session_id, action, gate_name, reason) VALUES (?, ?, ?, ?, ?)",
		).run(projectId, sid, entry.action, entry.gate_name ?? null, entry.reason);

		// Trim oldest entries beyond max
		db.prepare(
			`DELETE FROM audit_log WHERE project_id = ? AND id NOT IN (
				SELECT id FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT ?
			)`,
		).run(projectId, projectId, MAX_ENTRIES);
	} catch {
		/* fail-open */
	}
}

/** Read the audit log. Returns empty array on any error. */
export function readAuditLog(): AuditEntry[] {
	try {
		const db = getDb();
		const projectId = getProjectId();
		const rows = db
			.prepare(
				"SELECT action, reason, gate_name, created_at FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT ?",
			)
			.all(projectId, MAX_ENTRIES) as {
			action: string;
			reason: string | null;
			gate_name: string | null;
			created_at: string;
		}[];
		return rows.map((r) => ({
			action: r.action,
			reason: r.reason ?? "",
			gate_name: r.gate_name ?? undefined,
			timestamp: r.created_at,
		}));
	} catch {
		return [];
	}
}
