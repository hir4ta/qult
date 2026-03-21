import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 9;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    remote          TEXT DEFAULT '',
    path            TEXT NOT NULL,
    branch          TEXT DEFAULT '',
    registered_at   TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    status          TEXT DEFAULT 'active',
    metadata        TEXT DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_remote_path
    ON projects(remote, path);

CREATE TABLE IF NOT EXISTS knowledge_index (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    sub_type        TEXT NOT NULL DEFAULT 'decision',
    branch          TEXT DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    hit_count       INTEGER DEFAULT 0,
    last_accessed   TEXT DEFAULT '',
    enabled         INTEGER DEFAULT 1,
    UNIQUE(project_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_ki_project ON knowledge_index(project_id);
CREATE INDEX IF NOT EXISTS idx_ki_sub_type ON knowledge_index(sub_type);
CREATE INDEX IF NOT EXISTS idx_ki_updated ON knowledge_index(updated_at);

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

CREATE TABLE IF NOT EXISTS spec_index (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    slug            TEXT NOT NULL,
    file_name       TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    title           TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL,
    size            TEXT NOT NULL DEFAULT 'M',
    spec_type       TEXT NOT NULL DEFAULT 'feature',
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE(project_id, slug, file_name)
);

CREATE INDEX IF NOT EXISTS idx_si_project ON spec_index(project_id);
CREATE INDEX IF NOT EXISTS idx_si_slug ON spec_index(slug);
CREATE INDEX IF NOT EXISTS idx_si_status ON spec_index(status);

CREATE VIRTUAL TABLE IF NOT EXISTS spec_fts USING fts5(
    title,
    content,
    slug,
    content='spec_index',
    content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS si_fts_ai AFTER INSERT ON spec_index BEGIN
    INSERT INTO spec_fts(rowid, title, content, slug)
    VALUES (new.id, new.title, new.content, new.slug);
END;
CREATE TRIGGER IF NOT EXISTS si_fts_ad AFTER DELETE ON spec_index BEGIN
    INSERT INTO spec_fts(spec_fts, rowid, title, content, slug)
    VALUES ('delete', old.id, old.title, old.content, old.slug);
END;
CREATE TRIGGER IF NOT EXISTS si_fts_au AFTER UPDATE ON spec_index BEGIN
    INSERT INTO spec_fts(spec_fts, rowid, title, content, slug)
    VALUES ('delete', old.id, old.title, old.content, old.slug);
    INSERT INTO spec_fts(rowid, title, content, slug)
    VALUES (new.id, new.title, new.content, new.slug);
END;

CREATE TABLE IF NOT EXISTS tag_aliases (
    tag   TEXT NOT NULL,
    alias TEXT NOT NULL,
    PRIMARY KEY (tag, alias)
);

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
`;

const TAG_ALIASES: Record<string, string[]> = {
	auth: ["authentication", "login", "認証", "ログイン"],
	db: ["database", "sqlite", "データベース"],
	api: ["endpoint", "rest", "graphql"],
	test: ["testing", "テスト", "spec"],
	security: ["セキュリティ", "vulnerability", "脆弱性"],
	config: ["configuration", "settings", "設定"],
	deploy: ["deployment", "デプロイ", "release"],
	perf: ["performance", "パフォーマンス", "optimization", "最適化"],
	error: ["エラー", "bug", "バグ", "failure"],
	hook: ["hooks", "フック", "lifecycle"],
	memory: ["メモリ", "knowledge", "ナレッジ"],
	spec: ["specification", "仕様", "requirement"],
	embed: ["embedding", "埋め込み", "vector", "ベクトル"],
	search: ["検索", "query", "クエリ"],
	refactor: ["リファクタ", "cleanup", "restructure"],
	ci: ["ci/cd", "pipeline", "github actions"],
};

const LEGACY_TABLES = [
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

const LEGACY_TRIGGERS = [
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
	"ki_fts_ai",
	"ki_fts_ad",
	"ki_fts_au",
	"si_fts_ai",
	"si_fts_ad",
	"si_fts_au",
];

const LEGACY_INDEXES = [
	"idx_records_source_type",
	"idx_records_crawled_at",
	"idx_records_sub_type",
	"idx_embeddings_source",
	"idx_docs_source_type",
	"idx_docs_crawled_at",
	"idx_wseq_task",
	"idx_cochange_a",
	"idx_live_phases_session",
	"idx_live_files_session",
	"idx_gts_from",
	"idx_gtt_t1t2",
	"idx_decisions_session",
	"idx_decisions_timestamp",
	"idx_instincts_scope",
	"idx_instincts_domain",
	"idx_instincts_confidence",
	"idx_ki_project",
	"idx_ki_sub_type",
	"idx_ki_updated",
	"idx_si_project",
	"idx_si_slug",
	"idx_si_status",
	"idx_projects_remote_path",
];

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function dropSafe(db: Database.Database, kind: string, name: string): void {
	if (!SAFE_IDENTIFIER.test(name)) {
		throw new Error(`store: unsafe identifier in DROP ${kind}: "${name}"`);
	}
	db.exec(`DROP ${kind} IF EXISTS ${name}`);
}

function seedTagAliases(db: Database.Database): void {
	const stmt = db.prepare("INSERT OR IGNORE INTO tag_aliases (tag, alias) VALUES (?, ?)");
	for (const [tag, aliases] of Object.entries(TAG_ALIASES)) {
		for (const alias of aliases) {
			stmt.run(tag, alias);
		}
	}
}

function rebuildFromScratch(db: Database.Database): void {
	for (const trigger of LEGACY_TRIGGERS) {
		dropSafe(db, "TRIGGER", trigger);
	}
	for (const table of LEGACY_TABLES) {
		dropSafe(db, "TABLE", table);
	}
	for (const table of [
		"spec_fts",
		"spec_index",
		"knowledge_fts",
		"knowledge_index",
		"embeddings",
		"projects",
		"session_links",
		"tag_aliases",
		"schema_version",
	]) {
		dropSafe(db, "TABLE", table);
	}
	for (const idx of LEGACY_INDEXES) {
		dropSafe(db, "INDEX", idx);
	}
	db.exec(DDL);
	seedTagAliases(db);
}

function setSchemaVersion(db: Database.Database, ver: number): void {
	db.exec("DELETE FROM schema_version");
	db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(ver);
	db.pragma(`user_version = ${ver}`);
}

export function migrate(db: Database.Database): void {
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
		rebuildFromScratch(db);
		setSchemaVersion(db, SCHEMA_VERSION);
	});
	txn();
}
