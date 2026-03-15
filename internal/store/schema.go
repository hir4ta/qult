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

// schemaVersion 2 = FTS5 full-text search, tag aliases, fuzzy search support.
// V1→V2: additive (new virtual table + new table, no column changes).
const schemaVersion = 2

const ddl = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

-- ==========================================================
-- Records (specs, memories, project context)
-- ==========================================================
CREATE TABLE IF NOT EXISTS records (
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

CREATE INDEX IF NOT EXISTS idx_records_source_type ON records(source_type);
CREATE INDEX IF NOT EXISTS idx_records_crawled_at ON records(crawled_at);

-- ==========================================================
-- Full-Text Search (FTS5)
-- ==========================================================
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
    content,
    section_path,
    content='records',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS records_fts_ai AFTER INSERT ON records BEGIN
    INSERT INTO records_fts(rowid, content, section_path)
    VALUES (new.rowid, new.content, new.section_path);
END;
CREATE TRIGGER IF NOT EXISTS records_fts_ad AFTER DELETE ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, content, section_path)
    VALUES ('delete', old.rowid, old.content, old.section_path);
END;
CREATE TRIGGER IF NOT EXISTS records_fts_au AFTER UPDATE ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, content, section_path)
    VALUES ('delete', old.rowid, old.content, old.section_path);
    INSERT INTO records_fts(rowid, content, section_path)
    VALUES (new.rowid, new.content, new.section_path);
END;

-- ==========================================================
-- Tag Aliases (search expansion)
-- ==========================================================
CREATE TABLE IF NOT EXISTS tag_aliases (
    tag   TEXT NOT NULL,
    alias TEXT NOT NULL,
    PRIMARY KEY (tag, alias)
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
`

// legacyTables are tables from all previous versions that should be cleaned up.
var legacyTables = []string{
	// V2 tables (must drop before records to avoid stale FTS index)
	"records_fts", "tag_aliases",
	// Pre-v1 era
	"docs", "docs_fts", "crawl_meta", "doc_feedback", "instincts",
	"patterns", "pattern_tags", "pattern_files", "patterns_fts",
	"alerts", "alert_events",
	"suggestion_outcomes", "failure_solutions", "solution_chains",
	"learned_episodes", "feedbacks", "coaching_cache",
	"snr_history", "signal_outcomes", "user_pattern_effectiveness",
	"user_profile", "user_preferences", "adaptive_baselines",
	"workflow_sequences", "file_co_changes",
	"live_session_phases", "live_session_files",
	"global_tool_sequences", "global_tool_trigrams",
	"tags", "preferences",
	"sessions", "events", "compact_events", "decisions", "tool_failures",
}

var legacyTriggers = []string{
	"patterns_fts_ai", "patterns_fts_ad", "patterns_fts_au",
	"decisions_fts_ai", "decisions_fts_ad", "decisions_fts_au",
	"docs_fts_ai", "docs_fts_ad", "docs_fts_au",
	// V2 triggers (kept here for future rebuild-from-scratch cleanup)
	"records_fts_ai", "records_fts_ad", "records_fts_au",
}

var legacyIndexes = []string{
	"idx_embeddings_source",
	"idx_docs_source_type", "idx_docs_crawled_at",
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
	"idx_instincts_scope", "idx_instincts_domain", "idx_instincts_confidence",
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

// Migrate applies schema migrations. Pre-v1 databases are rebuilt from scratch.
// V1→V2 is additive (FTS5 + tag_aliases).
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

	switch {
	case current == 1:
		// V1→V2: additive migration (FTS5, tag_aliases, seed aliases).
		if err := migrateV1toV2(tx); err != nil {
			return err
		}
	default:
		// Pre-v1 or unknown: rebuild from scratch.
		if err := rebuildFromScratch(tx); err != nil {
			return err
		}
	}

	if err := setSchemaVersion(tx, schemaVersion); err != nil {
		return err
	}
	return tx.Commit()
}

// migrateV1toV2 adds FTS5 virtual table, sync triggers, tag_aliases table,
// and backfills the FTS index from existing records.
func migrateV1toV2(db execer) error {
	stmts := []string{
		// FTS5 virtual table
		`CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
			content, section_path,
			content='records', content_rowid='rowid'
		)`,
		// Sync triggers
		`CREATE TRIGGER IF NOT EXISTS records_fts_ai AFTER INSERT ON records BEGIN
			INSERT INTO records_fts(rowid, content, section_path)
			VALUES (new.rowid, new.content, new.section_path);
		END`,
		`CREATE TRIGGER IF NOT EXISTS records_fts_ad AFTER DELETE ON records BEGIN
			INSERT INTO records_fts(records_fts, rowid, content, section_path)
			VALUES ('delete', old.rowid, old.content, old.section_path);
		END`,
		`CREATE TRIGGER IF NOT EXISTS records_fts_au AFTER UPDATE ON records BEGIN
			INSERT INTO records_fts(records_fts, rowid, content, section_path)
			VALUES ('delete', old.rowid, old.content, old.section_path);
			INSERT INTO records_fts(rowid, content, section_path)
			VALUES (new.rowid, new.content, new.section_path);
		END`,
		// Tag aliases table
		`CREATE TABLE IF NOT EXISTS tag_aliases (
			tag   TEXT NOT NULL,
			alias TEXT NOT NULL,
			PRIMARY KEY (tag, alias)
		)`,
		// Backfill FTS index from existing records
		`INSERT INTO records_fts(rowid, content, section_path)
		 SELECT rowid, content, section_path FROM records`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("store: v1→v2 migration: %w", err)
		}
	}
	// Seed default tag aliases.
	if err := seedTagAliases(db); err != nil {
		return fmt.Errorf("store: seed tag aliases: %w", err)
	}
	return nil
}

// seedTagAliases inserts default tag alias mappings.
func seedTagAliases(db execer) error {
	aliases := map[string][]string{
		"auth":       {"authentication", "login", "認証", "ログイン"},
		"db":         {"database", "sqlite", "データベース"},
		"api":        {"endpoint", "rest", "graphql"},
		"test":       {"testing", "テスト", "spec"},
		"security":   {"セキュリティ", "vulnerability", "脆弱性"},
		"config":     {"configuration", "settings", "設定"},
		"deploy":     {"deployment", "デプロイ", "release"},
		"perf":       {"performance", "パフォーマンス", "optimization", "最適化"},
		"error":      {"エラー", "bug", "バグ", "failure"},
		"hook":       {"hooks", "フック", "lifecycle"},
		"memory":     {"メモリ", "knowledge", "ナレッジ"},
		"spec":       {"specification", "仕様", "requirement"},
		"embed":      {"embedding", "埋め込み", "vector", "ベクトル"},
		"search":     {"検索", "query", "クエリ"},
		"refactor":   {"リファクタ", "cleanup", "restructure"},
		"ci":         {"ci/cd", "pipeline", "github actions"},
	}
	for tag, aliasList := range aliases {
		for _, alias := range aliasList {
			if _, err := db.Exec(
				`INSERT OR IGNORE INTO tag_aliases (tag, alias) VALUES (?, ?)`,
				tag, alias,
			); err != nil {
				return err
			}
		}
	}
	return nil
}

// dropSafe executes a DROP IF EXISTS statement after validating the identifier.
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

// rebuildFromScratch drops all legacy tables and creates the v1 schema.
func rebuildFromScratch(db execer) error {
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
	for _, table := range []string{"embeddings", "records", "schema_version"} {
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
	// Seed default tag aliases for FTS search expansion.
	return seedTagAliases(db)
}

// setSchemaVersion writes the schema version.
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
