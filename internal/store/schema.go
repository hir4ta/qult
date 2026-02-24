package store

import "database/sql"

const schemaVersion = 1

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

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    user_text, assistant_text, tool_input, task_subject, plan_title,
    content='events', content_rowid='id'
);

-- FTS5 sync triggers for events
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, user_text, assistant_text, tool_input, task_subject, plan_title)
    VALUES (new.id, new.user_text, new.assistant_text, new.tool_input, new.task_subject, new.plan_title);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, user_text, assistant_text, tool_input, task_subject, plan_title)
    VALUES ('delete', old.id, old.user_text, old.assistant_text, old.tool_input, old.task_subject, old.plan_title);
END;

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

CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
    topic, decision_text, reasoning,
    content='decisions', content_rowid='id'
);

-- FTS5 sync triggers for decisions
CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
    INSERT INTO decisions_fts(rowid, topic, decision_text, reasoning)
    VALUES (new.id, new.topic, new.decision_text, new.reasoning);
END;

CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
    INSERT INTO decisions_fts(decisions_fts, rowid, topic, decision_text, reasoning)
    VALUES ('delete', old.id, old.topic, old.decision_text, old.reasoning);
END;
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

	// Upsert schema version.
	_, err := db.Exec(`DELETE FROM schema_version`)
	if err != nil {
		return err
	}
	_, err = db.Exec(`INSERT INTO schema_version (version) VALUES (?)`, schemaVersion)
	return err
}
