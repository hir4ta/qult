package store

import (
	"database/sql"
	"strconv"
)

// schemaVersion 101 = search quality upgrade (FTS5 porter, indexes, embedding reset).
const schemaVersion = 101

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

CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);

-- ==========================================================
-- User behavior tables
-- ==========================================================
CREATE TABLE IF NOT EXISTS user_profile (
    metric_name  TEXT PRIMARY KEY,
    ewma_value   REAL NOT NULL DEFAULT 0.0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_sequences (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT NOT NULL,
    task_type      TEXT NOT NULL,
    phase_sequence TEXT NOT NULL,
    success        INTEGER NOT NULL DEFAULT 0,
    tool_count     INTEGER NOT NULL DEFAULT 0,
    duration_sec   INTEGER NOT NULL DEFAULT 0,
    timestamp      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_wseq_task ON workflow_sequences(task_type);

CREATE TABLE IF NOT EXISTS adaptive_baselines (
    metric_name  TEXT PRIMARY KEY,
    count        INTEGER NOT NULL DEFAULT 0,
    mean         REAL NOT NULL DEFAULT 0.0,
    m2           REAL NOT NULL DEFAULT 0.0,
    last_updated TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_co_changes (
    file_a        TEXT NOT NULL,
    file_b        TEXT NOT NULL,
    session_count INTEGER NOT NULL DEFAULT 1,
    last_seen     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (file_a, file_b)
);
CREATE INDEX IF NOT EXISTS idx_cochange_a ON file_co_changes(file_a);

CREATE TABLE IF NOT EXISTS live_session_phases (
    session_id TEXT NOT NULL,
    phase      TEXT NOT NULL,
    tool_name  TEXT NOT NULL,
    timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_live_phases_session ON live_session_phases(session_id);

CREATE TABLE IF NOT EXISTS live_session_files (
    session_id TEXT NOT NULL,
    file_path  TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_live_files_session ON live_session_files(session_id);

CREATE TABLE IF NOT EXISTS global_tool_sequences (
    from_tool     TEXT NOT NULL,
    to_tool       TEXT NOT NULL,
    count         INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (from_tool, to_tool)
);
CREATE INDEX IF NOT EXISTS idx_gts_from ON global_tool_sequences(from_tool);

CREATE TABLE IF NOT EXISTS global_tool_trigrams (
    tool1         TEXT NOT NULL,
    tool2         TEXT NOT NULL,
    tool3         TEXT NOT NULL,
    count         INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tool1, tool2, tool3)
);
CREATE INDEX IF NOT EXISTS idx_gtt_t1t2 ON global_tool_trigrams(tool1, tool2);

CREATE TABLE IF NOT EXISTS user_preferences (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern               TEXT NOT NULL UNIQUE,
    delivery_count        INTEGER NOT NULL DEFAULT 0,
    resolution_count      INTEGER NOT NULL DEFAULT 0,
    ignore_count          INTEGER NOT NULL DEFAULT 0,
    avg_response_time_sec REAL NOT NULL DEFAULT 0,
    effectiveness_score   REAL NOT NULL DEFAULT 0.5,
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
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
-- Docs knowledge base (new in alfred v1)
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
    content='docs', content_rowid='id'
);

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
`

// ddlV101 upgrades from v100: FTS5 porter stemming, new indexes, embedding reset for 1024d.
const ddlV101 = `
-- Rebuild FTS5 with porter stemmer for better recall (configuring ≈ configuration).
DROP TRIGGER IF EXISTS docs_fts_ai;
DROP TRIGGER IF EXISTS docs_fts_ad;
DROP TRIGGER IF EXISTS docs_fts_au;
DROP TABLE IF EXISTS docs_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    section_path, content,
    content='docs', content_rowid='id',
    tokenize='porter unicode61',
    prefix='2,3'
);

-- Re-populate FTS from existing docs.
INSERT INTO docs_fts(rowid, section_path, content)
    SELECT id, section_path, content FROM docs;

-- Set column weights: section_path matches 10x more important than content.
INSERT INTO docs_fts(docs_fts, rank) VALUES('rank', 'bm25(10.0, 1.0)');

-- Recreate triggers for FTS sync.
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

-- Missing indexes for common query patterns.
CREATE INDEX IF NOT EXISTS idx_docs_source_type ON docs(source_type);
CREATE INDEX IF NOT EXISTS idx_docs_crawled_at ON docs(crawled_at);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, event_type);

-- Clear embeddings so they regenerate at new dimensions (2048d → 1024d).
DELETE FROM embeddings WHERE source = 'docs';
`

// legacyTables are tables from V1-V16 that no longer exist in alfred.
var legacyTables = []string{
	"patterns", "pattern_tags", "pattern_files", "patterns_fts",
	"alerts", "alert_events",
	"suggestion_outcomes", "failure_solutions", "solution_chains",
	"learned_episodes", "feedbacks", "coaching_cache",
	"snr_history", "signal_outcomes", "user_pattern_effectiveness",
}

var legacyTriggers = []string{
	"patterns_fts_ai", "patterns_fts_ad", "patterns_fts_au",
}

// SchemaVersion returns the current schema version constant.
func SchemaVersion() int { return schemaVersion }

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

	// Drop legacy tables from V1-V16.
	if current > 0 && current < schemaVersion {
		for _, trigger := range legacyTriggers {
			db.Exec("DROP TRIGGER IF EXISTS " + trigger)
		}
		for _, table := range legacyTables {
			db.Exec("DROP TABLE IF EXISTS " + table)
		}
	}

	if _, err := db.Exec(ddlV1); err != nil {
		return err
	}

	// Apply incremental migrations.
	if current < 101 {
		if _, err := db.Exec(ddlV101); err != nil {
			return err
		}
	}

	// Upsert schema version.
	_, err := db.Exec(`DELETE FROM schema_version`)
	if err != nil {
		return err
	}
	_, err = db.Exec(`INSERT INTO schema_version (version) VALUES (?)`, schemaVersion)
	if err != nil {
		return err
	}
	// Set PRAGMA user_version for fast-path skip in store.Open().
	_, err = db.Exec("PRAGMA user_version = " + strconv.Itoa(schemaVersion))
	return err
}
