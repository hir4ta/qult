package store

import (
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
)

// safeIdentifier validates SQL identifiers used in DDL concatenation.
var safeIdentifier = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// execer abstracts *sql.DB and *sql.Tx for DDL execution in migrations.
type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

// schemaVersion 8 = knowledge-first architecture.
// V8 is a full rewrite: records → knowledge_index, project identification, Markdown source of truth.
const schemaVersion = 8

const ddl = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

-- ==========================================================
-- Knowledge Index (derived from .alfred/knowledge/*.md files)
-- ==========================================================
CREATE TABLE IF NOT EXISTS knowledge_index (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path       TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    sub_type        TEXT NOT NULL DEFAULT 'general',
    project_remote  TEXT DEFAULT '',
    project_path    TEXT NOT NULL,
    project_name    TEXT NOT NULL DEFAULT '',
    branch          TEXT DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    hit_count       INTEGER DEFAULT 0,
    last_accessed   TEXT DEFAULT '',
    enabled         INTEGER DEFAULT 1,
    UNIQUE(project_remote, project_path, file_path)
);

CREATE INDEX IF NOT EXISTS idx_ki_project ON knowledge_index(project_remote, project_path);
CREATE INDEX IF NOT EXISTS idx_ki_sub_type ON knowledge_index(sub_type);
CREATE INDEX IF NOT EXISTS idx_ki_updated ON knowledge_index(updated_at);

-- ==========================================================
-- Full-Text Search (FTS5)
-- ==========================================================
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    title,
    content,
    sub_type,
    content='knowledge_index',
    content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS ki_fts_ai AFTER INSERT ON knowledge_index BEGIN
    INSERT INTO knowledge_fts(rowid, title, content, sub_type)
    VALUES (new.id, new.title, new.content, new.sub_type);
END;
CREATE TRIGGER IF NOT EXISTS ki_fts_ad AFTER DELETE ON knowledge_index BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, sub_type)
    VALUES ('delete', old.id, old.title, old.content, old.sub_type);
END;
CREATE TRIGGER IF NOT EXISTS ki_fts_au AFTER UPDATE ON knowledge_index BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, sub_type)
    VALUES ('delete', old.id, old.title, old.content, old.sub_type);
    INSERT INTO knowledge_fts(rowid, title, content, sub_type)
    VALUES (new.id, new.title, new.content, new.sub_type);
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
-- Embeddings (vector store)
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
-- Session Links (compaction continuity tracking)
-- ==========================================================
CREATE TABLE IF NOT EXISTS session_links (
    claude_session_id TEXT PRIMARY KEY,
    master_session_id TEXT NOT NULL,
    project_remote    TEXT DEFAULT '',
    project_path      TEXT NOT NULL DEFAULT '',
    task_slug         TEXT NOT NULL DEFAULT '',
    branch            TEXT DEFAULT '',
    linked_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_links_master ON session_links(master_session_id);
`

// legacyTables covers all tables from previous schema versions (V1-V7).
var legacyTables = []string{
	// V7 tables
	"records_fts", "records", "session_links",
	// V2 tables
	"tag_aliases",
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
	"records_fts_ai", "records_fts_ad", "records_fts_au",
	"patterns_fts_ai", "patterns_fts_ad", "patterns_fts_au",
	"decisions_fts_ai", "decisions_fts_ad", "decisions_fts_au",
	"docs_fts_ai", "docs_fts_ad", "docs_fts_au",
	// V8 triggers (for rebuild-from-scratch)
	"ki_fts_ai", "ki_fts_ad", "ki_fts_au",
}

var legacyIndexes = []string{
	// V7 indexes
	"idx_records_source_type", "idx_records_crawled_at", "idx_records_sub_type",
	"idx_embeddings_source",
	// Pre-v1
	"idx_docs_source_type", "idx_docs_crawled_at",
	"idx_wseq_task", "idx_cochange_a",
	"idx_live_phases_session", "idx_live_files_session",
	"idx_gts_from", "idx_gtt_t1t2",
	"idx_decisions_session", "idx_decisions_timestamp",
	"idx_events_session", "idx_tool_failures_session",
	"idx_instincts_scope", "idx_instincts_domain", "idx_instincts_confidence",
	// V8 indexes (for rebuild-from-scratch)
	"idx_ki_project", "idx_ki_sub_type", "idx_ki_updated",
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

// Migrate applies schema migrations. Any pre-V8 database is rebuilt from scratch.
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

	// V8 is a full rewrite — always rebuild from scratch for any prior version.
	if err := rebuildFromScratch(tx); err != nil {
		return err
	}

	if err := setSchemaVersion(tx, schemaVersion); err != nil {
		return err
	}
	return tx.Commit()
}

// seedTagAliases inserts default tag alias mappings.
func seedTagAliases(db execer) error {
	aliases := map[string][]string{
		"auth":     {"authentication", "login", "認証", "ログイン"},
		"db":       {"database", "sqlite", "データベース"},
		"api":      {"endpoint", "rest", "graphql"},
		"test":     {"testing", "テスト", "spec"},
		"security": {"セキュリティ", "vulnerability", "脆弱性"},
		"config":   {"configuration", "settings", "設定"},
		"deploy":   {"deployment", "デプロイ", "release"},
		"perf":     {"performance", "パフォーマンス", "optimization", "最適化"},
		"error":    {"エラー", "bug", "バグ", "failure"},
		"hook":     {"hooks", "フック", "lifecycle"},
		"memory":   {"メモリ", "knowledge", "ナレッジ"},
		"spec":     {"specification", "仕様", "requirement"},
		"embed":    {"embedding", "埋め込み", "vector", "ベクトル"},
		"search":   {"検索", "query", "クエリ"},
		"refactor": {"リファクタ", "cleanup", "restructure"},
		"ci":       {"ci/cd", "pipeline", "github actions"},
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

// rebuildFromScratch drops all legacy tables and creates the V8 schema.
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
	for _, table := range []string{"knowledge_fts", "knowledge_index", "embeddings", "session_links", "tag_aliases", "schema_version"} {
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
