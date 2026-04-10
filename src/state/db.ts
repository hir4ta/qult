/**
 * SQLite database singleton for qult state management.
 *
 * All state is stored in ~/.qult/qult.db (WAL mode).
 * Hooks (short-lived) and MCP server (long-lived) share the same schema.
 * Each process gets its own connection via getDb().
 *
 * State is project-scoped (identified by cwd). No session concept —
 * hooks and MCP always reference the same project row.
 */

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCHEMA_VERSION = 6;

const DB_DIR = join(homedir(), ".qult");
const DB_PATH = join(DB_DIR, "qult.db");

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
		createTablesV6(db);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		return;
	}
	// Legacy migrations (v1→v5) for existing databases
	if (version < 2) db.exec("DROP TABLE IF EXISTS calibration");
	if (version < 3) {
		try {
			db.exec("ALTER TABLE sessions ADD COLUMN semantic_warning_count INTEGER NOT NULL DEFAULT 0");
		} catch {
			/* fail-open */
		}
	}
	if (version < 4) {
		for (const col of [
			"test_quality_warning_count INTEGER NOT NULL DEFAULT 0",
			"duplication_warning_count INTEGER NOT NULL DEFAULT 0",
			"semantic_warning_count INTEGER NOT NULL DEFAULT 0",
			"drift_warning_count INTEGER NOT NULL DEFAULT 0",
			"escalation_hit INTEGER NOT NULL DEFAULT 0",
		]) {
			try {
				db.exec(`ALTER TABLE session_metrics ADD COLUMN ${col}`);
			} catch {
				/* fail-open */
			}
		}
	}
	if (version < 5) {
		db.exec(`CREATE TABLE IF NOT EXISTS file_edit_counts (
			session_id TEXT NOT NULL, file TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (session_id, file)
		)`);
	}
	// v6: migrate session-based → project-based state
	if (version < 6) migrateToProjectState(db);
	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Migrate from session-based state to project-based state. */
function migrateToProjectState(db: Database): void {
	// 1. Add state columns to projects
	for (const col of [
		"last_commit_at TEXT",
		"test_passed_at TEXT",
		"test_command TEXT",
		"review_completed_at TEXT",
		"review_iteration INTEGER NOT NULL DEFAULT 0",
		"plan_eval_iteration INTEGER NOT NULL DEFAULT 0",
		"plan_selfcheck_blocked_at TEXT",
		"human_review_approved_at TEXT",
		"security_warning_count INTEGER NOT NULL DEFAULT 0",
		"test_quality_warning_count INTEGER NOT NULL DEFAULT 0",
		"drift_warning_count INTEGER NOT NULL DEFAULT 0",
		"dead_import_warning_count INTEGER NOT NULL DEFAULT 0",
		"duplication_warning_count INTEGER NOT NULL DEFAULT 0",
		"semantic_warning_count INTEGER NOT NULL DEFAULT 0",
	]) {
		try {
			db.exec(`ALTER TABLE projects ADD COLUMN ${col}`);
		} catch {
			/* column may already exist */
		}
	}

	// 2. Copy latest session state to projects
	try {
		db.exec(`UPDATE projects SET
			test_passed_at = (SELECT s.test_passed_at FROM sessions s WHERE s.project_id = projects.id ORDER BY s.rowid DESC LIMIT 1),
			review_completed_at = (SELECT s.review_completed_at FROM sessions s WHERE s.project_id = projects.id ORDER BY s.rowid DESC LIMIT 1),
			review_iteration = COALESCE((SELECT s.review_iteration FROM sessions s WHERE s.project_id = projects.id ORDER BY s.rowid DESC LIMIT 1), 0)
		`);
	} catch {
		/* fail-open */
	}

	// 3. Recreate child tables with project_id FK
	const migrations: { name: string; ddl: string; copy: string }[] = [
		{
			name: "pending_fixes",
			ddl: `(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, file TEXT NOT NULL, gate TEXT NOT NULL, errors TEXT NOT NULL, UNIQUE(project_id, file, gate))`,
			copy: `INSERT OR IGNORE INTO pending_fixes_v6 (project_id, file, gate, errors) SELECT s.project_id, t.file, t.gate, t.errors FROM pending_fixes t JOIN sessions s ON t.session_id = s.id`,
		},
		{
			name: "changed_files",
			ddl: `(project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, file_path TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY (project_id, file_path))`,
			copy: `INSERT OR IGNORE INTO changed_files_v6 (project_id, file_path) SELECT s.project_id, t.file_path FROM changed_files t JOIN sessions s ON t.session_id = s.id`,
		},
		{
			name: "disabled_gates",
			ddl: `(project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, gate_name TEXT NOT NULL, reason TEXT NOT NULL, disabled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY (project_id, gate_name))`,
			copy: `INSERT OR IGNORE INTO disabled_gates_v6 (project_id, gate_name, reason) SELECT s.project_id, t.gate_name, t.reason FROM disabled_gates t JOIN sessions s ON t.session_id = s.id`,
		},
		{
			name: "ran_gates",
			ddl: `(project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, gate_name TEXT NOT NULL, ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY (project_id, gate_name))`,
			copy: `INSERT OR IGNORE INTO ran_gates_v6 (project_id, gate_name, ran_at) SELECT s.project_id, t.gate_name, t.ran_at FROM ran_gates t JOIN sessions s ON t.session_id = s.id`,
		},
		{
			name: "task_verify_results",
			ddl: `(project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, task_key TEXT NOT NULL, passed INTEGER NOT NULL, ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY (project_id, task_key))`,
			copy: `INSERT OR IGNORE INTO task_verify_results_v6 (project_id, task_key, passed, ran_at) SELECT s.project_id, t.task_key, t.passed, t.ran_at FROM task_verify_results t JOIN sessions s ON t.session_id = s.id`,
		},
		{
			name: "gate_failure_counts",
			ddl: `(project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, file TEXT NOT NULL, gate TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (project_id, file, gate))`,
			copy: `INSERT OR IGNORE INTO gate_failure_counts_v6 (project_id, file, gate, count) SELECT s.project_id, t.file, t.gate, t.count FROM gate_failure_counts t JOIN sessions s ON t.session_id = s.id`,
		},
		{
			name: "file_edit_counts",
			ddl: `(project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, file TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (project_id, file))`,
			copy: `INSERT OR IGNORE INTO file_edit_counts_v6 (project_id, file, count) SELECT s.project_id, t.file, t.count FROM file_edit_counts t JOIN sessions s ON t.session_id = s.id`,
		},
		{
			name: "review_scores",
			ddl: `(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, iteration INTEGER NOT NULL, aggregate_score REAL NOT NULL, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(project_id, iteration))`,
			copy: `INSERT OR IGNORE INTO review_scores_v6 (project_id, iteration, aggregate_score, recorded_at) SELECT s.project_id, t.iteration, t.aggregate_score, t.recorded_at FROM review_scores t JOIN sessions s ON t.session_id = s.id`,
		},
		{
			name: "review_stage_scores",
			ddl: `(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, stage TEXT NOT NULL, dimension TEXT NOT NULL, score REAL NOT NULL, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(project_id, stage, dimension))`,
			copy: `INSERT OR IGNORE INTO review_stage_scores_v6 (project_id, stage, dimension, score, recorded_at) SELECT s.project_id, t.stage, t.dimension, t.score, t.recorded_at FROM review_stage_scores t JOIN sessions s ON t.session_id = s.id`,
		},
		{
			name: "plan_eval_scores",
			ddl: `(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, iteration INTEGER NOT NULL, aggregate_score REAL NOT NULL, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(project_id, iteration))`,
			copy: `INSERT OR IGNORE INTO plan_eval_scores_v6 (project_id, iteration, aggregate_score, recorded_at) SELECT s.project_id, t.iteration, t.aggregate_score, t.recorded_at FROM plan_eval_scores t JOIN sessions s ON t.session_id = s.id`,
		},
		{
			name: "review_findings",
			ddl: `(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), file TEXT NOT NULL, severity TEXT NOT NULL, description TEXT NOT NULL, stage TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
			copy: `INSERT INTO review_findings_v6 (project_id, file, severity, description, stage, recorded_at) SELECT t.project_id, t.file, t.severity, t.description, t.stage, t.recorded_at FROM review_findings t`,
		},
	];

	db.exec("PRAGMA foreign_keys = OFF");
	for (const m of migrations) {
		try {
			db.exec(`CREATE TABLE ${m.name}_v6 ${m.ddl}`);
			db.exec(m.copy);
			db.exec(`DROP TABLE IF EXISTS ${m.name}`);
			db.exec(`ALTER TABLE ${m.name}_v6 RENAME TO ${m.name}`);
		} catch {
			/* fail-open */
		}
	}

	// session_metrics: make session_id nullable
	try {
		db.exec(`CREATE TABLE session_metrics_v6 (
			id INTEGER PRIMARY KEY, session_id TEXT, project_id INTEGER NOT NULL REFERENCES projects(id),
			gate_failure_count INTEGER NOT NULL DEFAULT 0, security_warning_count INTEGER NOT NULL DEFAULT 0,
			review_aggregate REAL, files_changed INTEGER NOT NULL DEFAULT 0,
			test_quality_warning_count INTEGER NOT NULL DEFAULT 0, duplication_warning_count INTEGER NOT NULL DEFAULT 0,
			semantic_warning_count INTEGER NOT NULL DEFAULT 0, drift_warning_count INTEGER NOT NULL DEFAULT 0,
			escalation_hit INTEGER NOT NULL DEFAULT 0,
			recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		)`);
		db.exec(`INSERT INTO session_metrics_v6 SELECT * FROM session_metrics`);
		db.exec("DROP TABLE session_metrics");
		db.exec("ALTER TABLE session_metrics_v6 RENAME TO session_metrics");
	} catch {
		/* fail-open */
	}

	db.exec("PRAGMA foreign_keys = ON");
}

/** Fresh database schema (version 6). */
function createTablesV6(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS projects (
			id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			last_commit_at TEXT, test_passed_at TEXT, test_command TEXT,
			review_completed_at TEXT, review_iteration INTEGER NOT NULL DEFAULT 0,
			plan_eval_iteration INTEGER NOT NULL DEFAULT 0, plan_selfcheck_blocked_at TEXT,
			human_review_approved_at TEXT,
			security_warning_count INTEGER NOT NULL DEFAULT 0,
			test_quality_warning_count INTEGER NOT NULL DEFAULT 0,
			drift_warning_count INTEGER NOT NULL DEFAULT 0,
			dead_import_warning_count INTEGER NOT NULL DEFAULT 0,
			duplication_warning_count INTEGER NOT NULL DEFAULT 0,
			semantic_warning_count INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
			started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE TABLE IF NOT EXISTS pending_fixes (
			id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			file TEXT NOT NULL, gate TEXT NOT NULL, errors TEXT NOT NULL,
			UNIQUE(project_id, file, gate)
		);
		CREATE TABLE IF NOT EXISTS changed_files (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			file_path TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (project_id, file_path)
		);
		CREATE TABLE IF NOT EXISTS disabled_gates (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			gate_name TEXT NOT NULL, reason TEXT NOT NULL,
			disabled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (project_id, gate_name)
		);
		CREATE TABLE IF NOT EXISTS ran_gates (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			gate_name TEXT NOT NULL, ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (project_id, gate_name)
		);
		CREATE TABLE IF NOT EXISTS task_verify_results (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			task_key TEXT NOT NULL, passed INTEGER NOT NULL,
			ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			PRIMARY KEY (project_id, task_key)
		);
		CREATE TABLE IF NOT EXISTS gate_failure_counts (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			file TEXT NOT NULL, gate TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (project_id, file, gate)
		);
		CREATE TABLE IF NOT EXISTS file_edit_counts (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			file TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (project_id, file)
		);
		CREATE TABLE IF NOT EXISTS review_scores (
			id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			iteration INTEGER NOT NULL, aggregate_score REAL NOT NULL,
			recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE(project_id, iteration)
		);
		CREATE TABLE IF NOT EXISTS review_stage_scores (
			id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			stage TEXT NOT NULL, dimension TEXT NOT NULL, score REAL NOT NULL,
			recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE(project_id, stage, dimension)
		);
		CREATE TABLE IF NOT EXISTS plan_eval_scores (
			id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			iteration INTEGER NOT NULL, aggregate_score REAL NOT NULL,
			recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			UNIQUE(project_id, iteration)
		);
		CREATE TABLE IF NOT EXISTS gate_configs (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			phase TEXT NOT NULL, gate_name TEXT NOT NULL, command TEXT NOT NULL,
			timeout INTEGER, run_once_per_batch INTEGER NOT NULL DEFAULT 0, extensions TEXT,
			PRIMARY KEY (project_id, phase, gate_name)
		);
		CREATE TABLE IF NOT EXISTS project_configs (
			project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project_id, key)
		);
		CREATE TABLE IF NOT EXISTS global_configs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS audit_log (
			id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
			session_id TEXT, action TEXT NOT NULL, gate_name TEXT, reason TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE TABLE IF NOT EXISTS session_metrics (
			id INTEGER PRIMARY KEY, session_id TEXT,
			project_id INTEGER NOT NULL REFERENCES projects(id),
			gate_failure_count INTEGER NOT NULL DEFAULT 0, security_warning_count INTEGER NOT NULL DEFAULT 0,
			review_aggregate REAL, files_changed INTEGER NOT NULL DEFAULT 0,
			test_quality_warning_count INTEGER NOT NULL DEFAULT 0, duplication_warning_count INTEGER NOT NULL DEFAULT 0,
			semantic_warning_count INTEGER NOT NULL DEFAULT 0, drift_warning_count INTEGER NOT NULL DEFAULT 0,
			escalation_hit INTEGER NOT NULL DEFAULT 0,
			recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		);
		CREATE TABLE IF NOT EXISTS review_findings (
			id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
			file TEXT NOT NULL, severity TEXT NOT NULL, description TEXT NOT NULL,
			stage TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
	_projectIdCache = null;
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

// ── Exports for tests ────────────────────────────────────

export { DB_DIR, DB_PATH };
