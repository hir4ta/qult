import type { DbDatabase } from "./db.js";

export const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    remote          TEXT DEFAULT '',
    path            TEXT NOT NULL,
    registered_at   TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    status          TEXT DEFAULT 'active'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_path ON projects(path);

CREATE TABLE IF NOT EXISTS knowledge_index (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type            TEXT NOT NULL CHECK(type IN ('error_resolution','fix_pattern','convention','decision')),
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    tags            TEXT DEFAULT '',
    author          TEXT DEFAULT '',
    hit_count       INTEGER DEFAULT 0,
    last_accessed   TEXT DEFAULT '',
    enabled         INTEGER DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE(project_id, type, title)
);
CREATE INDEX IF NOT EXISTS idx_ki_project ON knowledge_index(project_id);
CREATE INDEX IF NOT EXISTS idx_ki_type ON knowledge_index(type);

CREATE TABLE IF NOT EXISTS embeddings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT NOT NULL DEFAULT 'knowledge',
    source_id  INTEGER NOT NULL,
    model      TEXT NOT NULL,
    dims       INTEGER NOT NULL,
    vector     BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (source, source_id)
);

CREATE TABLE IF NOT EXISTS quality_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id  TEXT DEFAULT '',
    event_type  TEXT NOT NULL CHECK(event_type IN (
        'gate_pass','gate_fail',
        'error_hit','error_miss',
        'test_pass','test_fail',
        'assertion_warning',
        'convention_pass','convention_warn',
        'plan_created','knowledge_saved'
    )),
    data        TEXT DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_qe_project ON quality_events(project_id);
CREATE INDEX IF NOT EXISTS idx_qe_session ON quality_events(session_id);
CREATE INDEX IF NOT EXISTS idx_qe_type ON quality_events(event_type);
`;

/**
 * Drop everything and rebuild from scratch.
 * V1 is a clean start — no migration from v0.x.
 */
function rebuildFromScratch(db: DbDatabase): void {
	// Drop all known tables (v0.x legacy + v1)
	const allTables = [
		// v0.x legacy
		"knowledge_fts",
		"spec_fts",
		"spec_index",
		"tag_aliases",
		"session_links",
		"audit_log",
		// v1
		"quality_events",
		"embeddings",
		"knowledge_index",
		"projects",
		"schema_version",
		// ancient legacy
		"records_fts",
		"records",
		"docs",
		"docs_fts",
		"crawl_meta",
		"doc_feedback",
		"instincts",
		"patterns",
		"pattern_tags",
		"pattern_files",
		"patterns_fts",
		"alerts",
		"alert_events",
		"suggestion_outcomes",
		"failure_solutions",
		"solution_chains",
		"learned_episodes",
		"feedbacks",
		"coaching_cache",
		"snr_history",
		"signal_outcomes",
		"user_pattern_effectiveness",
		"user_profile",
		"user_preferences",
		"adaptive_baselines",
		"workflow_sequences",
		"file_co_changes",
		"live_session_phases",
		"live_session_files",
		"global_tool_sequences",
		"global_tool_trigrams",
		"tags",
		"preferences",
		"sessions",
		"events",
		"compact_events",
		"decisions",
		"tool_failures",
	];

	// Drop triggers first
	const triggers = [
		"ki_fts_ai",
		"ki_fts_ad",
		"ki_fts_au",
		"si_fts_ai",
		"si_fts_ad",
		"si_fts_au",
		"records_fts_ai",
		"records_fts_ad",
		"records_fts_au",
		"patterns_fts_ai",
		"patterns_fts_ad",
		"patterns_fts_au",
		"decisions_fts_ai",
		"decisions_fts_ad",
		"decisions_fts_au",
		"docs_fts_ai",
		"docs_fts_ad",
		"docs_fts_au",
	];
	for (const t of triggers) {
		db.exec(`DROP TRIGGER IF EXISTS ${t}`);
	}
	for (const t of allTables) {
		db.exec(`DROP TABLE IF EXISTS ${t}`);
	}

	db.exec(DDL);
}

function setSchemaVersion(db: DbDatabase, ver: number): void {
	db.exec("DELETE FROM schema_version");
	db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(ver);
	db.exec(`PRAGMA user_version = ${ver}`);
}

function migrateV1toV2(db: DbDatabase): void {
	// Rebuild knowledge_index with updated CHECK constraint (exemplar removed, fix_pattern+decision added)
	db.exec(`
		CREATE TABLE knowledge_index_v2 (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			type            TEXT NOT NULL CHECK(type IN ('error_resolution','fix_pattern','convention','decision')),
			title           TEXT NOT NULL,
			content         TEXT NOT NULL,
			tags            TEXT DEFAULT '',
			author          TEXT DEFAULT '',
			hit_count       INTEGER DEFAULT 0,
			last_accessed   TEXT DEFAULT '',
			enabled         INTEGER DEFAULT 1,
			created_at      TEXT NOT NULL,
			updated_at      TEXT NOT NULL,
			UNIQUE(project_id, type, title)
		);
		INSERT INTO knowledge_index_v2 SELECT * FROM knowledge_index WHERE type != 'exemplar';
		DROP TABLE knowledge_index;
		ALTER TABLE knowledge_index_v2 RENAME TO knowledge_index;
		CREATE INDEX IF NOT EXISTS idx_ki_project ON knowledge_index(project_id);
		CREATE INDEX IF NOT EXISTS idx_ki_type ON knowledge_index(type);
	`);

	// Rebuild quality_events with expanded CHECK constraint
	db.exec(`
		CREATE TABLE quality_events_v2 (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			session_id  TEXT DEFAULT '',
			event_type  TEXT NOT NULL CHECK(event_type IN (
				'gate_pass','gate_fail',
				'error_hit','error_miss',
				'test_pass','test_fail',
				'assertion_warning',
				'convention_pass','convention_warn',
				'plan_created','knowledge_saved'
			)),
			data        TEXT DEFAULT '{}',
			created_at  TEXT NOT NULL DEFAULT (datetime('now'))
		);
		INSERT INTO quality_events_v2 SELECT * FROM quality_events;
		DROP TABLE quality_events;
		ALTER TABLE quality_events_v2 RENAME TO quality_events;
		CREATE INDEX IF NOT EXISTS idx_qe_project ON quality_events(project_id);
		CREATE INDEX IF NOT EXISTS idx_qe_session ON quality_events(session_id);
		CREATE INDEX IF NOT EXISTS idx_qe_type ON quality_events(event_type);
	`);
}

export function migrate(db: DbDatabase): void {
	let current = 0;
	try {
		const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
			| { version: number }
			| undefined;
		if (row) current = row.version;
	} catch {
		// Table doesn't exist yet.
	}
	if (current === SCHEMA_VERSION) return;

	const txn = db.transaction(() => {
		if (current === 1) {
			migrateV1toV2(db);
		} else {
			rebuildFromScratch(db);
		}
		setSchemaVersion(db, SCHEMA_VERSION);
	});
	txn();
}
