/**
 * Append-only audit log for gate / pending-fix actions.
 *
 * Stored as line-delimited JSON at `.qult/state/audit-log.ndjson`. Each line
 * is one {@link AuditEntry}. Read returns the most recent entries (up to
 * {@link MAX_ENTRIES}) in DESC order, matching the prior SQLite behavior.
 */

import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureDir } from "./fs.ts";
import { assertConfinedToQult, qultDir } from "./paths.ts";

const MAX_ENTRIES = 200;

export interface AuditEntry {
	action: string;
	reason: string;
	gate_name?: string;
	timestamp: string;
}

function auditLogPath(): string {
	return resolve(qultDir(), "state", "audit-log.ndjson");
}

/** Append an entry to the audit log. Fail-open: silently swallows errors. */
export function appendAuditLog(entry: AuditEntry): void {
	try {
		const path = auditLogPath();
		assertConfinedToQult(path);
		ensureDir(resolve(path, ".."));
		appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
		trimIfOverflowing(path);
	} catch {
		/* fail-open */
	}
}

/** Read the audit log, most recent first, up to MAX_ENTRIES. */
export function readAuditLog(): AuditEntry[] {
	try {
		const path = auditLogPath();
		assertConfinedToQult(path);
		const txt = (() => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return "";
			}
		})();
		const out: AuditEntry[] = [];
		for (const line of txt.split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line) as AuditEntry);
			} catch {
				/* skip malformed line */
			}
		}
		return out.reverse().slice(0, MAX_ENTRIES);
	} catch {
		return [];
	}
}

/** If the file has more than 1.5 × MAX_ENTRIES lines, rewrite to keep only the most recent MAX_ENTRIES. */
function trimIfOverflowing(path: string): void {
	try {
		const txt = readFileSync(path, "utf8");
		const lines = txt.split("\n").filter((l) => l.trim().length > 0);
		if (lines.length <= MAX_ENTRIES * 1.5) return;
		const kept = lines.slice(-MAX_ENTRIES);
		// Rewrite atomically via tmp+rename to avoid torn read.
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${kept.join("\n")}\n`, "utf8");
		renameSync(tmp, path);
	} catch {
		/* fail-open */
	}
}
