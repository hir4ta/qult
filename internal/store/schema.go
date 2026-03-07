package store

import (
	"database/sql"
	"strconv"
)

// schemaVersion 4 = removed redundant index + embedding 2048d.
// Changes from V3:
//   - Removed redundant idx_embeddings_source (UNIQUE constraint already creates implicit index)
const schemaVersion = 4

const ddl = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
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
-- Indexes
-- ==========================================================
CREATE INDEX IF NOT EXISTS idx_docs_source_type ON docs(source_type);
CREATE INDEX IF NOT EXISTS idx_docs_crawled_at ON docs(crawled_at);
`

// legacyTables are tables from previous versions that no longer exist.
var legacyTables = []string{
	// V1-V16 era
	"patterns", "pattern_tags", "pattern_files", "patterns_fts",
	"alerts", "alert_events",
	"suggestion_outcomes", "failure_solutions", "solution_chains",
	"learned_episodes", "feedbacks", "coaching_cache",
	"snr_history", "signal_outcomes", "user_pattern_effectiveness",
	// V100 era (dropped in V200 passive butler reset)
	"user_profile", "user_preferences", "adaptive_baselines",
	"workflow_sequences", "file_co_changes",
	"live_session_phases", "live_session_files",
	"global_tool_sequences", "global_tool_trigrams",
	"tags",
	// V1-V2 era (dropped in V3 fully passive)
	"preferences",
	"sessions", "events", "compact_events", "decisions", "tool_failures",
}

var legacyTriggers = []string{
	"patterns_fts_ai", "patterns_fts_ad", "patterns_fts_au",
	"decisions_fts_ai", "decisions_fts_ad", "decisions_fts_au",
}

var legacyIndexes = []string{
	"idx_embeddings_source",
	"idx_wseq_task",
	"idx_cochange_a",
	"idx_live_phases_session",
	"idx_live_files_session",
	"idx_gts_from",
	"idx_gtt_t1t2",
	"idx_decisions_session",
	"idx_decisions_timestamp",
	"idx_events_session",
	"idx_tool_failures_session",
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

	// Breaking change — drop everything and rebuild.
	if current != 0 {
		// Drop FTS virtual tables first (triggers reference them).
		for _, vt := range []string{"decisions_fts", "docs_fts"} {
			db.Exec("DROP TABLE IF EXISTS " + vt)
		}
		// Drop triggers.
		for _, trigger := range legacyTriggers {
			db.Exec("DROP TRIGGER IF EXISTS " + trigger)
		}
		for _, trigger := range []string{
			"docs_fts_ai", "docs_fts_ad", "docs_fts_au",
		} {
			db.Exec("DROP TRIGGER IF EXISTS " + trigger)
		}
		// Drop all known tables.
		for _, table := range legacyTables {
			db.Exec("DROP TABLE IF EXISTS " + table)
		}
		for _, table := range []string{"embeddings", "docs", "schema_version"} {
			db.Exec("DROP TABLE IF EXISTS " + table)
		}
		for _, idx := range legacyIndexes {
			db.Exec("DROP INDEX IF EXISTS " + idx)
		}
	}

	if _, err := db.Exec(ddl); err != nil {
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
