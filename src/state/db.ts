/**
 * SQLite database singleton for qult state management.
 *
 * All state is stored in ~/.qult/qult.db (WAL mode).
 * Hooks (short-lived) and MCP server (long-lived) share the same schema.
 * Each process gets its own connection via getDb().
 */

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCHEMA_VERSION = 5;

const DB_DIR = join(homedir(), ".qult");
const DB_PATH = join(DB_DIR, "qult.db");
const DEFAULT_SESSION_ID = "__default__";

// ── Singleton ────────────────────────────────────────────

let _db: Database | null = null;

/** Open (or return cached) database connection. Creates ~/.qult/ and schema on first call. */
export function getDb(): Database {
	if (_db) return _db;
	mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
	try {
		chmodSync(DB_DIR, 0o700);
	} catch {
		/* fail-open: permission change may fail on some filesystems */
	}
	_db = new Database(DB_PATH);
	configurePragmas(_db);
	migrateSchema(_db);
	return _db;
}

/** Replace the singleton with an in-memory database (for tests). */
export function useTestDb(): Database {
	closeDb();
	_db = new Database(":memory:");
	configurePragmas(_db);
	migrateSchema(_db);
	return _db;
}

/** Close the database connection and clear the singleton. */
export function closeDb(): void {
	try {
		_db?.close();
	} catch {
		/* ignore close errors */
	}
	_db = null;
	_projectIdCache = null;
	_sessionId = DEFAULT_SESSION_ID;
}

function configurePragmas(db: Database): void {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA foreign_keys = ON");
}

// ── Schema ───────────────────────────────────────────────

function migrateSchema(db: Database): void {
	const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
		.user_version;
	if (version >= SCHEMA_VERSION) return;
	if (version < 1) {
		createTablesV1(db);
	}
	if (version < 2) {
		// Version 2: remove calibration table
		db.exec("DROP TABLE IF EXISTS calibration");
	}
	if (version < 3) {
		// Version 3: add semantic_warning_count to sessions
		try {
			db.exec("ALTER TABLE sessions ADD COLUMN semantic_warning_count INTEGER NOT NULL DEFAULT 0");
		} catch {
			/* fail-open: column may already exist */
		}
	}
	if (version < 4) {
		// Version 4: add extended metrics columns to session_metrics
		const v4Columns = [
			"test_quality_warning_count INTEGER NOT NULL DEFAULT 0",
			"duplication_warning_count INTEGER NOT NULL DEFAULT 0",
			"semantic_warning_count INTEGER NOT NULL DEFAULT 0",
			"drift_warning_count INTEGER NOT NULL DEFAULT 0",
			"escalation_hit INTEGER NOT NULL DEFAULT 0",
		];
		for (const col of v4Columns) {
			try {
				db.exec(`ALTER TABLE session_metrics ADD COLUMN ${col}`);
			} catch {
				/* fail-open: column may already exist */
			}
		}
	}
	if (version < 5) {
		// Version 5: add file_edit_counts table for iterative security escalation
		db.exec(`CREATE TABLE IF NOT EXISTS file_edit_counts (
			session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			file       TEXT    NOT NULL,
			count      INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (session_id, file)
		)`);
	}
	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function createTablesV1(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS projects (
			id         INTEGER PRIMARY KEY,
			path       TEXT    NOT NULL UNIQUE,
			created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);

		CREATE TABLE IF NOT EXISTS sessions (
			id                          TEXT    PRIMARY KEY,
			project_id                  INTEGER NOT NULL REFERENCES projects(id),
			started_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			last_commit_at              TEXT,
			test_passed_at              TEXT,
			test_command                TEXT,
			review_completed_at         TEXT,
			review_iteration            INTEGER NOT NULL DEFAULT 0,
			plan_eval_iteration         INTEGER NOT NULL DEFAULT 0,
			plan_selfcheck_blocked_at   TEXT,
			human_review_approved_at    TEXT,
			security_warning_count      INTEGER NOT NULL DEFAULT 0,
			test_quality_warning_count  INTEGER NOT NULL DEFAULT 0,
			drift_warning_count         INTEGER NOT NULL DEFAULT 0,
			dead_import_warning_count   INTEGER NOT NULL DEFAULT 0,
			duplication_warning_count   INTEGER NOT NULL DEFAULT 0,
			semantic_warning_count     INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

		CREATE TABLE IF NOT EXISTS pending_fixes (
			id         INTEGER PRIMARY KEY,
			session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			file       TEXT    NOT NULL,
			gate       TEXT    NOT NULL,
			errors     TEXT    NOT NULL,
			UNIQUE(session_id, file, gate)
		);
		CREATE INDEX IF NOT EXISTS idx_pending_fixes_session ON pending_fixes(session_id);

		CREATE TABLE IF NOT EXISTS changed_files (
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			file_path  TEXT NOT NULL,
			changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (session_id, file_path)
		);

		CREATE TABLE IF NOT EXISTS disabled_gates (
			session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			gate_name   TEXT NOT NULL,
			reason      TEXT NOT NULL,
			disabled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (session_id, gate_name)
		);

		CREATE TABLE IF NOT EXISTS ran_gates (
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			gate_name  TEXT NOT NULL,
			ran_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (session_id, gate_name)
		);

		CREATE TABLE IF NOT EXISTS task_verify_results (
			session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			task_key   TEXT    NOT NULL,
			passed     INTEGER NOT NULL,
			ran_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (session_id, task_key)
		);

		CREATE TABLE IF NOT EXISTS gate_failure_counts (
			session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			file       TEXT    NOT NULL,
			gate       TEXT    NOT NULL,
			count      INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (session_id, file, gate)
		);

		CREATE TABLE IF NOT EXISTS review_scores (
			id              INTEGER PRIMARY KEY,
			session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			iteration       INTEGER NOT NULL,
			aggregate_score REAL    NOT NULL,
			recorded_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE(session_id, iteration)
		);
		CREATE INDEX IF NOT EXISTS idx_review_scores_session ON review_scores(session_id);

		CREATE TABLE IF NOT EXISTS review_stage_scores (
			id          INTEGER PRIMARY KEY,
			session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			stage       TEXT NOT NULL,
			dimension   TEXT NOT NULL,
			score       REAL NOT NULL,
			recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE(session_id, stage, dimension)
		);
		CREATE INDEX IF NOT EXISTS idx_stage_scores_session ON review_stage_scores(session_id);

		CREATE TABLE IF NOT EXISTS plan_eval_scores (
			id              INTEGER PRIMARY KEY,
			session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			iteration       INTEGER NOT NULL,
			aggregate_score REAL    NOT NULL,
			recorded_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE(session_id, iteration)
		);

		CREATE TABLE IF NOT EXISTS gate_configs (
			project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			phase              TEXT    NOT NULL,
			gate_name          TEXT    NOT NULL,
			command            TEXT    NOT NULL,
			timeout            INTEGER,
			run_once_per_batch INTEGER NOT NULL DEFAULT 0,
			extensions         TEXT,
			PRIMARY KEY (project_id, phase, gate_name)
		);

		CREATE TABLE IF NOT EXISTS project_configs (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			key        TEXT    NOT NULL,
			value      TEXT    NOT NULL,
			PRIMARY KEY (project_id, key)
		);

		CREATE TABLE IF NOT EXISTS global_configs (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS audit_log (
			id         INTEGER PRIMARY KEY,
			project_id INTEGER NOT NULL REFERENCES projects(id),
			session_id TEXT,
			action     TEXT NOT NULL,
			gate_name  TEXT,
			reason     TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log(session_id);

		CREATE TABLE IF NOT EXISTS session_metrics (
			id                              INTEGER PRIMARY KEY,
			session_id                      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			project_id                      INTEGER NOT NULL REFERENCES projects(id),
			gate_failure_count              INTEGER NOT NULL DEFAULT 0,
			security_warning_count          INTEGER NOT NULL DEFAULT 0,
			review_aggregate                REAL,
			files_changed                   INTEGER NOT NULL DEFAULT 0,
			test_quality_warning_count      INTEGER NOT NULL DEFAULT 0,
			duplication_warning_count       INTEGER NOT NULL DEFAULT 0,
			semantic_warning_count          INTEGER NOT NULL DEFAULT 0,
			drift_warning_count             INTEGER NOT NULL DEFAULT 0,
			escalation_hit                  INTEGER NOT NULL DEFAULT 0,
			recorded_at                     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE INDEX IF NOT EXISTS idx_metrics_project ON session_metrics(project_id);

		CREATE TABLE IF NOT EXISTS review_findings (
			id          INTEGER PRIMARY KEY,
			session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			project_id  INTEGER NOT NULL REFERENCES projects(id),
			file        TEXT    NOT NULL,
			severity    TEXT    NOT NULL,
			description TEXT    NOT NULL,
			stage       TEXT    NOT NULL,
			recorded_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE INDEX IF NOT EXISTS idx_review_findings_session ON review_findings(session_id);
		CREATE TABLE IF NOT EXISTS file_edit_counts (
			session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			file       TEXT    NOT NULL,
			count      INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (session_id, file)
		);
	`);
}

// ── Project resolution ───────────────────────────────────

let _projectIdCache: number | null = null;
let _projectPathCache: string | null = null;

/** Set the project path for this process. Call early (e.g., in dispatcher). */
export function setProjectPath(path: string): void {
	if (path === _projectPathCache) return;
	_projectPathCache = path;
	_projectIdCache = null; // invalidate
}

/** Get the project ID for the current project path. Inserts if new. */
export function getProjectId(): number {
	if (_projectIdCache !== null) return _projectIdCache;
	const path = _projectPathCache ?? process.cwd();
	const db = getDb();
	db.prepare("INSERT OR IGNORE INTO projects (path) VALUES (?)").run(path);
	const row = db.prepare("SELECT id FROM projects WHERE path = ?").get(path) as {
		id: number;
	} | null;
	if (!row) throw new Error(`Failed to resolve project: ${path}`);
	_projectIdCache = row.id;
	return _projectIdCache;
}

// ── Session resolution ───────────────────────────────────

let _sessionId: string = DEFAULT_SESSION_ID;

/** Set the session ID for this process. Rejects path-traversal characters. */
export function setSessionScope(sessionId: string): boolean {
	if (!/^[\w.\-:]+$/.test(sessionId)) {
		process.stderr.write(
			`[qult] Ignoring invalid session_id (contains illegal characters): ${sessionId.slice(0, 64)}\n`,
		);
		return false;
	}
	_sessionId = sessionId;
	return true;
}

/** Get the current session ID. */
export function getSessionId(): string {
	return _sessionId;
}

/** Ensure the current session exists in the database. Call after setSessionScope + setProjectPath. */
export function ensureSession(): void {
	const db = getDb();
	const projectId = getProjectId();
	db.prepare("INSERT OR IGNORE INTO sessions (id, project_id) VALUES (?, ?)").run(
		_sessionId,
		projectId,
	);
}

/** Find the most recent session for the current project. Used by MCP server.
 *  Uses rowid (insertion order) instead of started_at to match the session
 *  that hooks most recently called ensureSession() for. This prevents
 *  MCP-hook session ID mismatch when multiple sessions exist. */
export function findLatestSessionId(): string | null {
	const db = getDb();
	const projectId = getProjectId();
	const row = db
		.prepare("SELECT id FROM sessions WHERE project_id = ? ORDER BY rowid DESC LIMIT 1")
		.get(projectId) as { id: string } | null;
	return row?.id ?? null;
}

// ── Exports for tests ────────────────────────────────────

export { DB_DIR, DB_PATH, DEFAULT_SESSION_ID };
