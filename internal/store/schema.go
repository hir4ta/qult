package store

import (
	"database/sql"
	"strconv"
)

// schemaVersion 1 = 静観型執事 V1 reset.
// Clean slate: sessions, events, compact_events, decisions, preferences,
// docs, embeddings. All legacy tables are dropped on migration.
const schemaVersion = 1

const ddlV1 = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

-- ==========================================================
-- Core tables
-- ==========================================================
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

-- ==========================================================
-- User preferences (静観型執事: remember user preferences)
-- ==========================================================
CREATE TABLE IF NOT EXISTS preferences (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'explicit',
    confidence REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(category, key)
);

-- ==========================================================
-- Embeddings (generic vector store)
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
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source, source_id);

-- ==========================================================
-- Docs knowledge base
-- ==========================================================
CREATE TABLE IF NOT EXISTS docs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    url          TEXT NOT NULL,
    section_path TEXT NOT NULL,
    content      TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_type  TEXT NOT NULL,
    version      TEXT,
    crawled_at   TEXT NOT NULL,
    ttl_days     INTEGER DEFAULT 7,
    UNIQUE(url, section_path)
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    section_path, content,
    content='docs', content_rowid='id',
    tokenize='porter unicode61',
    prefix='2,3'
);

INSERT OR IGNORE INTO docs_fts(docs_fts, rank) VALUES('rank', 'bm25(10.0, 1.0)');

CREATE TRIGGER IF NOT EXISTS docs_fts_ai AFTER INSERT ON docs BEGIN
    INSERT INTO docs_fts(rowid, section_path, content)
    VALUES (new.id, new.section_path, new.content);
END;

CREATE TRIGGER IF NOT EXISTS docs_fts_ad AFTER DELETE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, section_path, content)
    VALUES ('delete', old.id, old.section_path, old.content);
END;

CREATE TRIGGER IF NOT EXISTS docs_fts_au AFTER UPDATE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, section_path, content)
    VALUES ('delete', old.id, old.section_path, old.content);
    INSERT INTO docs_fts(rowid, section_path, content)
    VALUES (new.id, new.section_path, new.content);
END;

-- ==========================================================
-- Decisions FTS5
-- ==========================================================
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
    topic, decision_text, reasoning,
    content='decisions', content_rowid='id',
    tokenize='porter unicode61',
    prefix='2,3'
);

INSERT OR IGNORE INTO decisions_fts(decisions_fts, rank) VALUES('rank', 'bm25(10.0, 5.0, 1.0)');

CREATE TRIGGER IF NOT EXISTS decisions_fts_ai AFTER INSERT ON decisions BEGIN
    INSERT INTO decisions_fts(rowid, topic, decision_text, reasoning)
    VALUES (new.id, new.topic, new.decision_text, COALESCE(new.reasoning, ''));
END;

CREATE TRIGGER IF NOT EXISTS decisions_fts_ad AFTER DELETE ON decisions BEGIN
    INSERT INTO decisions_fts(decisions_fts, rowid, topic, decision_text, reasoning)
    VALUES ('delete', old.id, old.topic, old.decision_text, COALESCE(old.reasoning, ''));
END;

CREATE TRIGGER IF NOT EXISTS decisions_fts_au AFTER UPDATE ON decisions BEGIN
    INSERT INTO decisions_fts(decisions_fts, rowid, topic, decision_text, reasoning)
    VALUES ('delete', old.id, old.topic, old.decision_text, COALESCE(old.reasoning, ''));
    INSERT INTO decisions_fts(rowid, topic, decision_text, reasoning)
    VALUES (new.id, new.topic, new.decision_text, COALESCE(new.reasoning, ''));
END;

-- ==========================================================
-- Indexes
-- ==========================================================
CREATE INDEX IF NOT EXISTS idx_docs_source_type ON docs(source_type);
CREATE INDEX IF NOT EXISTS idx_docs_crawled_at ON docs(crawled_at);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, event_type);
`

// legacyTables are tables from previous versions that no longer exist.
var legacyTables = []string{
	// V1-V16 era
	"patterns", "pattern_tags", "pattern_files", "patterns_fts",
	"alerts", "alert_events",
	"suggestion_outcomes", "failure_solutions", "solution_chains",
	"learned_episodes", "feedbacks", "coaching_cache",
	"snr_history", "signal_outcomes", "user_pattern_effectiveness",
	// V100 era (dropped in V200 静観型執事 reset)
	"user_profile", "user_preferences", "adaptive_baselines",
	"workflow_sequences", "file_co_changes",
	"live_session_phases", "live_session_files",
	"global_tool_sequences", "global_tool_trigrams",
	"tags",
}

var legacyTriggers = []string{
	"patterns_fts_ai", "patterns_fts_ad", "patterns_fts_au",
}

var legacyIndexes = []string{
	"idx_wseq_task",
	"idx_cochange_a",
	"idx_live_phases_session",
	"idx_live_files_session",
	"idx_gts_from",
	"idx_gtt_t1t2",
}

// SchemaVersion returns the current schema version constant.
func SchemaVersion() int { return schemaVersion }

// Migrate applies all pending schema migrations to the database.
func Migrate(db *sql.DB) error {
	var current int
	row := db.QueryRow("SELECT version FROM schema_version LIMIT 1")
	if err := row.Scan(&current); err != nil {
		current = 0
	}
	if current == schemaVersion {
		return nil
	}

	// Drop legacy tables, triggers, and indexes from previous versions.
	if current != 0 {
		for _, trigger := range legacyTriggers {
			db.Exec("DROP TRIGGER IF EXISTS " + trigger)
		}
		for _, table := range legacyTables {
			db.Exec("DROP TABLE IF EXISTS " + table)
		}
		for _, idx := range legacyIndexes {
			db.Exec("DROP INDEX IF EXISTS " + idx)
		}
	}

	if _, err := db.Exec(ddlV1); err != nil {
		return err
	}

	// Upsert schema version.
	if _, err := db.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := db.Exec(`INSERT INTO schema_version (version) VALUES (?)`, schemaVersion); err != nil {
		return err
	}
	_, err := db.Exec("PRAGMA user_version = " + strconv.Itoa(schemaVersion))
	return err
}
