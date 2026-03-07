package store

import (
	"database/sql"
	"fmt"
	"strconv"
)

// schemaVersion 4 = removed redundant index + embedding 2048d.
// Changes from V3:
//   - Removed redundant idx_embeddings_source (UNIQUE constraint already creates implicit index)
//
// Migration policy (V4+):
//   - Incremental migrations preserve existing data (docs, embeddings).
//   - Legacy schemas (< 3) are still rebuilt from scratch.
const schemaVersion = 4

// minIncrementalVersion is the lowest version from which we can migrate
// incrementally (without data loss). Versions below this are rebuilt.
const minIncrementalVersion = 3

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
	// V100 era (dropped in V200 reset)
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

// incrementalMigrations maps source version → SQL statements to apply.
// Each entry migrates from version N to N+1.
// Add new entries here for future schema changes.
var incrementalMigrations = map[int][]string{
	3: {
		// V3 → V4: remove redundant index (UNIQUE constraint already creates one).
		"DROP INDEX IF EXISTS idx_embeddings_source",
	},
	// Future example:
	// 4: {
	//     "ALTER TABLE docs ADD COLUMN language TEXT DEFAULT ''",
	// },
}

// SchemaVersion returns the current schema version constant.
func SchemaVersion() int { return schemaVersion }

// Migrate applies all pending schema migrations to the database.
// For legacy schemas (< minIncrementalVersion), the database is rebuilt.
// For schemas >= minIncrementalVersion, incremental migrations are applied
// preserving all existing data (docs, embeddings).
func Migrate(db *sql.DB) error {
	var current int
	row := db.QueryRow("SELECT version FROM schema_version LIMIT 1")
	if err := row.Scan(&current); err != nil {
		current = 0
	}
	if current == schemaVersion {
		return nil
	}

	if current > 0 && current < minIncrementalVersion {
		// Legacy schema — too different to migrate incrementally.
		if err := rebuildFromScratch(db); err != nil {
			return err
		}
	} else if current == 0 {
		// Fresh install — create everything.
		if err := cleanupLegacy(db); err != nil {
			return err
		}
		if _, err := db.Exec(ddl); err != nil {
			return err
		}
	} else {
		// Incremental migration: apply steps from current → schemaVersion.
		for v := current; v < schemaVersion; v++ {
			stmts, ok := incrementalMigrations[v]
			if !ok {
				continue
			}
			for _, stmt := range stmts {
				if _, err := db.Exec(stmt); err != nil {
					return err
				}
			}
		}
	}

	return setSchemaVersion(db, schemaVersion)
}

// rebuildFromScratch drops all tables and recreates the schema.
// Used only for legacy schemas that are incompatible with incremental migration.
func rebuildFromScratch(db *sql.DB) error {
	// Drop FTS virtual tables first (triggers reference them).
	for _, vt := range []string{"decisions_fts", "docs_fts"} {
		if _, err := db.Exec("DROP TABLE IF EXISTS " + vt); err != nil {
			return fmt.Errorf("drop FTS table %s: %w", vt, err)
		}
	}
	// Drop triggers.
	for _, trigger := range legacyTriggers {
		if _, err := db.Exec("DROP TRIGGER IF EXISTS " + trigger); err != nil {
			return fmt.Errorf("drop trigger %s: %w", trigger, err)
		}
	}
	for _, trigger := range []string{
		"docs_fts_ai", "docs_fts_ad", "docs_fts_au",
	} {
		if _, err := db.Exec("DROP TRIGGER IF EXISTS " + trigger); err != nil {
			return fmt.Errorf("drop trigger %s: %w", trigger, err)
		}
	}
	// Drop all known tables.
	for _, table := range legacyTables {
		if _, err := db.Exec("DROP TABLE IF EXISTS " + table); err != nil {
			return fmt.Errorf("drop table %s: %w", table, err)
		}
	}
	for _, table := range []string{"embeddings", "docs", "schema_version"} {
		if _, err := db.Exec("DROP TABLE IF EXISTS " + table); err != nil {
			return fmt.Errorf("drop table %s: %w", table, err)
		}
	}
	for _, idx := range legacyIndexes {
		if _, err := db.Exec("DROP INDEX IF EXISTS " + idx); err != nil {
			return fmt.Errorf("drop index %s: %w", idx, err)
		}
	}
	if _, err := db.Exec(ddl); err != nil {
		return err
	}
	return nil
}

// cleanupLegacy removes legacy tables/triggers/indexes that may exist
// from previous installations sharing the same DB path.
func cleanupLegacy(db *sql.DB) error {
	for _, trigger := range legacyTriggers {
		if _, err := db.Exec("DROP TRIGGER IF EXISTS " + trigger); err != nil {
			return fmt.Errorf("cleanup trigger %s: %w", trigger, err)
		}
	}
	for _, table := range legacyTables {
		if _, err := db.Exec("DROP TABLE IF EXISTS " + table); err != nil {
			return fmt.Errorf("cleanup table %s: %w", table, err)
		}
	}
	for _, idx := range legacyIndexes {
		if _, err := db.Exec("DROP INDEX IF EXISTS " + idx); err != nil {
			return fmt.Errorf("cleanup index %s: %w", idx, err)
		}
	}
	return nil
}

func setSchemaVersion(db *sql.DB, ver int) error {
	if _, err := db.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := db.Exec(`INSERT INTO schema_version (version) VALUES (?)`, ver); err != nil {
		return err
	}
	_, err := db.Exec("PRAGMA user_version = " + strconv.Itoa(ver))
	return err
}
