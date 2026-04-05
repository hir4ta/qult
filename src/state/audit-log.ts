import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-write.ts";

export interface AuditEntry {
	action: string;
	reason: string;
	gate_name?: string;
	timestamp: string;
}

const STATE_DIR = ".qult/.state";
const AUDIT_LOG_FILE = "audit-log.json";
const MAX_ENTRIES = 200;

/** Append an entry to the audit log. Fail-open: silently swallows errors. */
export function appendAuditLog(cwd: string, entry: AuditEntry): void {
	try {
		const logPath = join(cwd, STATE_DIR, AUDIT_LOG_FILE);
		let log = readAuditLog(cwd);
		log.push(entry);
		if (log.length > MAX_ENTRIES) {
			log = log.slice(-MAX_ENTRIES);
		}
		atomicWriteJson(logPath, log);
	} catch {
		/* fail-open */
	}
}

/** Read the audit log. Returns empty array on any error. */
export function readAuditLog(cwd: string): AuditEntry[] {
	try {
		const logPath = join(cwd, STATE_DIR, AUDIT_LOG_FILE);
		if (!existsSync(logPath)) return [];
		const parsed = JSON.parse(readFileSync(logPath, "utf-8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
