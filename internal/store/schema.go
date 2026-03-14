package store

import (
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
)

// safeIdentifier validates SQL identifiers used in DDL concatenation.
// Only allows alphanumeric characters and underscores.
var safeIdentifier = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// execer abstracts *sql.DB and *sql.Tx for DDL execution in migrations.
type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

// schemaVersion 8 = simplification: remove FTS, crawl_meta, doc_feedback, instincts.
// Changes from V7:
//   - Dropped docs_fts virtual table + triggers
//   - Dropped crawl_meta, doc_feedback, instincts tables
//   - Deleted non-memory/spec rows from docs
//   - Cleaned orphaned embeddings
//
// Migration policy (V4+):
//   - Incremental migrations preserve existing data (docs, embeddings).
//   - Legacy schemas (< 3) are still rebuilt from scratch.
const schemaVersion = 8

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
	4: {
		// V4 → V5: add crawl_meta table for HTTP conditional requests.
		`CREATE TABLE IF NOT EXISTS crawl_meta (
			url             TEXT PRIMARY KEY,
			etag            TEXT DEFAULT '',
			last_modified   TEXT DEFAULT '',
			last_crawled_at TEXT NOT NULL
		)`,
	},
	5: {
		// V5 → V6: add doc_feedback table for implicit relevance signals.
		`CREATE TABLE IF NOT EXISTS doc_feedback (
			doc_id         INTEGER PRIMARY KEY,
			positive_hits  INTEGER DEFAULT 0,
			negative_hits  INTEGER DEFAULT 0,
			last_injected  TEXT,
			last_feedback  TEXT
		)`,
	},
	6: {
		// V6 → V7: add instincts table (now removed in V8, but migration path preserved).
		`CREATE TABLE IF NOT EXISTS instincts (
			id             INTEGER PRIMARY KEY AUTOINCREMENT,
			trigger        TEXT NOT NULL,
			action         TEXT NOT NULL,
			confidence     REAL NOT NULL DEFAULT 0.5,
			domain         TEXT NOT NULL DEFAULT 'general',
			scope          TEXT NOT NULL DEFAULT 'project',
			project_hash   TEXT NOT NULL DEFAULT '',
			source_session TEXT DEFAULT '',
			evidence       TEXT DEFAULT '',
			times_applied  INTEGER DEFAULT 0,
			created_at     TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_instincts_scope ON instincts(scope, project_hash)`,
		`CREATE INDEX IF NOT EXISTS idx_instincts_domain ON instincts(domain)`,
		`CREATE INDEX IF NOT EXISTS idx_instincts_confidence ON instincts(confidence)`,
	},
	7: {
		// V7 → V8: simplification — remove FTS, crawl_meta, doc_feedback, instincts.
		// Drop triggers BEFORE FTS virtual table (SQLite requirement).
		`DROP TRIGGER IF EXISTS docs_fts_ai`,
		`DROP TRIGGER IF EXISTS docs_fts_ad`,
		`DROP TRIGGER IF EXISTS docs_fts_au`,
		`DROP TABLE IF EXISTS docs_fts`,
		`DROP TABLE IF EXISTS crawl_meta`,
		`DROP TABLE IF EXISTS doc_feedback`,
		`DROP TABLE IF EXISTS instincts`,
		// Delete non-memory/spec/project rows from docs.
		`DELETE FROM docs WHERE source_type NOT IN ('memory', 'spec', 'project')`,
		// Clean orphaned embeddings.
		`DELETE FROM embeddings WHERE source_id NOT IN (SELECT id FROM docs)`,
	},
}

// SchemaVersion returns the target schema version constant.
func SchemaVersion() int { return schemaVersion }

// SchemaVersionCurrent returns the actual schema version from the database.
func (s *Store) SchemaVersionCurrent() int {
	var v int
	if err := s.db.QueryRow("SELECT version FROM schema_version LIMIT 1").Scan(&v); err != nil {
		return 0
	}
	return v
}

// Migrate applies all pending schema migrations to the database.
// For legacy schemas (< minIncrementalVersion), the database is rebuilt.
// For schemas >= minIncrementalVersion, incremental migrations are applied
// preserving all existing data (docs, embeddings).
// All mutations are wrapped in a transaction for atomicity.
func Migrate(db *sql.DB) error {
	var current int
	row := db.QueryRow("SELECT version FROM schema_version LIMIT 1")
	if err := row.Scan(&current); err != nil {
		current = 0
	}
	if current == schemaVersion {
		return nil
	}

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("store: begin migration tx: %w", err)
	}
	defer tx.Rollback()

	if current > 0 && current < minIncrementalVersion {
		// Legacy schema — too different to migrate incrementally.
		if err := rebuildFromScratch(tx); err != nil {
			return err
		}
	} else if current == 0 {
		// Fresh install — create everything.
		if err := cleanupLegacy(tx); err != nil {
			return err
		}
		if _, err := tx.Exec(ddl); err != nil {
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
				if _, err := tx.Exec(stmt); err != nil {
					return err
				}
			}
		}
	}

	if err := setSchemaVersion(tx, schemaVersion); err != nil {
		return err
	}
	return tx.Commit()
}

// dropSafe executes a DROP IF EXISTS statement after validating the identifier
// against safeIdentifier to prevent SQL injection via string concatenation.
func dropSafe(db execer, kind, name string) error {
	if !safeIdentifier.MatchString(name) {
		return fmt.Errorf("store: unsafe identifier in DROP %s: %q", kind, name)
	}
	_, err := db.Exec("DROP " + kind + " IF EXISTS " + name)
	if err != nil {
		return fmt.Errorf("drop %s %s: %w", kind, name, err)
	}
	return nil
}

// rebuildFromScratch drops all tables and recreates the schema.
// Used only for legacy schemas that are incompatible with incremental migration.
func rebuildFromScratch(db execer) error {
	// Drop FTS virtual tables first (triggers reference them).
	for _, vt := range []string{"decisions_fts", "docs_fts"} {
		if err := dropSafe(db, "TABLE", vt); err != nil {
			return err
		}
	}
	// Drop triggers (legacy + docs FTS).
	for _, trigger := range legacyTriggers {
		if err := dropSafe(db, "TRIGGER", trigger); err != nil {
			return err
		}
	}
	for _, trigger := range []string{
		"docs_fts_ai", "docs_fts_ad", "docs_fts_au",
	} {
		if err := dropSafe(db, "TRIGGER", trigger); err != nil {
			return err
		}
	}
	// Drop all known tables (including V7-era tables removed in V8).
	for _, table := range legacyTables {
		if err := dropSafe(db, "TABLE", table); err != nil {
			return err
		}
	}
	for _, table := range []string{"crawl_meta", "doc_feedback", "instincts"} {
		if err := dropSafe(db, "TABLE", table); err != nil {
			return err
		}
	}
	for _, table := range []string{"embeddings", "docs", "schema_version"} {
		if err := dropSafe(db, "TABLE", table); err != nil {
			return err
		}
	}
	for _, idx := range legacyIndexes {
		if err := dropSafe(db, "INDEX", idx); err != nil {
			return err
		}
	}
	if _, err := db.Exec(ddl); err != nil {
		return err
	}
	return nil
}

// cleanupLegacy removes legacy tables/triggers/indexes that may exist
// from previous installations sharing the same DB path.
func cleanupLegacy(db execer) error {
	for _, trigger := range legacyTriggers {
		if err := dropSafe(db, "TRIGGER", trigger); err != nil {
			return err
		}
	}
	for _, table := range legacyTables {
		if err := dropSafe(db, "TABLE", table); err != nil {
			return err
		}
	}
	for _, idx := range legacyIndexes {
		if err := dropSafe(db, "INDEX", idx); err != nil {
			return err
		}
	}
	return nil
}

// setSchemaVersion writes the schema version to both the schema_version table
// and PRAGMA user_version. PRAGMA inside a tx is driver-specific;
// confirmed working with ncruces/go-sqlite3 (WAL mode).
func setSchemaVersion(db execer, ver int) error {
	if _, err := db.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := db.Exec(`INSERT INTO schema_version (version) VALUES (?)`, ver); err != nil {
		return err
	}
	_, err := db.Exec("PRAGMA user_version = " + strconv.Itoa(ver))
	return err
}
