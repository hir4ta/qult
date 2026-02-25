package store

import "database/sql"

const schemaVersion = 3

const ddlV1 = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    project_path    TEXT NOT NULL,
    project_name    TEXT NOT NULL,
    jsonl_path      TEXT NOT NULL,
    first_event_at  TEXT,
    last_event_at   TEXT,
    first_prompt    TEXT,
    summary         TEXT,
    turn_count      INTEGER NOT NULL DEFAULT 0,
    tool_use_count  INTEGER NOT NULL DEFAULT 0,
    compact_count   INTEGER NOT NULL DEFAULT 0,
    parent_session_id TEXT,
    synced_offset   INTEGER NOT NULL DEFAULT 0,
    synced_at       TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    event_type      INTEGER NOT NULL,
    timestamp       TEXT NOT NULL,
    user_text       TEXT,
    assistant_text  TEXT,
    tool_name       TEXT,
    tool_input      TEXT,
    task_id         TEXT,
    task_subject    TEXT,
    task_status     TEXT,
    agent_name      TEXT,
    plan_title      TEXT,
    raw_json        TEXT,
    byte_offset     INTEGER,
    compact_segment INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS compact_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    segment_index   INTEGER NOT NULL,
    summary_text    TEXT,
    timestamp       TEXT,
    pre_turn_count  INTEGER NOT NULL DEFAULT 0,
    pre_tool_count  INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS decisions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    event_id        INTEGER,
    timestamp       TEXT NOT NULL,
    topic           TEXT NOT NULL,
    decision_text   TEXT NOT NULL,
    reasoning       TEXT,
    file_paths      TEXT,
    compact_segment INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

`

const ddlV2 = `
-- ==========================================================
-- tags master (normalized: junction table instead of JSON array)
-- ==========================================================
CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

-- ==========================================================
-- patterns table (knowledge unit)
-- ==========================================================
CREATE TABLE IF NOT EXISTS patterns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    pattern_type    TEXT NOT NULL,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    embed_text      TEXT NOT NULL,
    language        TEXT,
    scope           TEXT NOT NULL DEFAULT 'project',
    source_event_id INTEGER,
    timestamp       TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (source_event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS pattern_tags (
    pattern_id INTEGER NOT NULL,
    tag_id     INTEGER NOT NULL,
    PRIMARY KEY (pattern_id, tag_id),
    FOREIGN KEY (pattern_id) REFERENCES patterns(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pattern_files (
    pattern_id INTEGER NOT NULL,
    file_path  TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'related',
    PRIMARY KEY (pattern_id, file_path),
    FOREIGN KEY (pattern_id) REFERENCES patterns(id) ON DELETE CASCADE
);

-- ==========================================================
-- alerts table (anti-pattern detection records)
-- ==========================================================
CREATE TABLE IF NOT EXISTS alerts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    pattern_type    TEXT NOT NULL,
    level           TEXT NOT NULL,
    situation       TEXT,
    observation     TEXT,
    suggestion      TEXT,
    event_count     INTEGER,
    first_event_id  INTEGER,
    last_event_id   INTEGER,
    timestamp       TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (first_event_id) REFERENCES events(id),
    FOREIGN KEY (last_event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS alert_events (
    alert_id  INTEGER NOT NULL,
    event_id  INTEGER NOT NULL,
    PRIMARY KEY (alert_id, event_id),
    FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES events(id)
);

-- ==========================================================
-- embeddings (BLOB storage, cosine similarity computed in Go)
-- ==========================================================
CREATE TABLE IF NOT EXISTS embeddings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT NOT NULL,
    source_id  INTEGER NOT NULL,
    model      TEXT NOT NULL,
    dims       INTEGER NOT NULL,
    vector     BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (source, source_id)
);

-- ==========================================================
-- indexes
-- ==========================================================
CREATE INDEX IF NOT EXISTS idx_patterns_session ON patterns(session_id);
CREATE INDEX IF NOT EXISTS idx_patterns_type ON patterns(pattern_type);
CREATE INDEX IF NOT EXISTS idx_patterns_scope ON patterns(scope);
CREATE INDEX IF NOT EXISTS idx_alerts_session ON alerts(session_id);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(pattern_type);
CREATE INDEX IF NOT EXISTS idx_pattern_tags_tag ON pattern_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source, source_id);
`

const ddlV3 = `
-- Drop all FTS5 virtual tables and triggers (migrating to vector-only search).
DROP TRIGGER IF EXISTS events_ai;
DROP TRIGGER IF EXISTS events_ad;
DROP TRIGGER IF EXISTS decisions_ai;
DROP TRIGGER IF EXISTS decisions_ad;
DROP TRIGGER IF EXISTS patterns_ai;
DROP TRIGGER IF EXISTS patterns_ad;
DROP TABLE IF EXISTS events_fts;
DROP TABLE IF EXISTS decisions_fts;
DROP TABLE IF EXISTS patterns_fts;
`

// Migrate applies all pending schema migrations to the database.
func Migrate(db *sql.DB) error {
	var current int
	row := db.QueryRow("SELECT version FROM schema_version LIMIT 1")
	if err := row.Scan(&current); err != nil {
		// Table doesn't exist yet or is empty; current stays 0.
		current = 0
	}
	if current >= schemaVersion {
		return nil
	}

	if current < 1 {
		if _, err := db.Exec(ddlV1); err != nil {
			return err
		}
	}
	if current < 2 {
		if _, err := db.Exec(ddlV2); err != nil {
			return err
		}
	}
	if current < 3 {
		if _, err := db.Exec(ddlV3); err != nil {
			return err
		}
	}

	// Upsert schema version.
	_, err := db.Exec(`DELETE FROM schema_version`)
	if err != nil {
		return err
	}
	_, err = db.Exec(`INSERT INTO schema_version (version) VALUES (?)`, schemaVersion)
	return err
}
