package sessiondb

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	_ "github.com/ncruces/go-sqlite3/driver"
	_ "github.com/ncruces/go-sqlite3/embed"
)

var validSessionID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

const ddl = `
CREATE TABLE IF NOT EXISTS hook_events (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	tool_name  TEXT    NOT NULL DEFAULT '',
	input_hash TEXT    NOT NULL DEFAULT '0000000000000000',
	is_write   INTEGER NOT NULL DEFAULT 0,
	timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS burst_state (
	id         INTEGER PRIMARY KEY CHECK (id = 1),
	tool_count INTEGER NOT NULL DEFAULT 0,
	has_write  INTEGER NOT NULL DEFAULT 0,
	start_time TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_reads (
	path  TEXT    PRIMARY KEY,
	count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cooldowns (
	pattern TEXT PRIMARY KEY,
	expiry  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS compact_events (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	timestamp TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nudge_outbox (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	pattern      TEXT NOT NULL,
	level        TEXT NOT NULL,
	observation  TEXT NOT NULL,
	suggestion   TEXT NOT NULL,
	created_at   TEXT NOT NULL DEFAULT (datetime('now')),
	delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS session_context (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS file_last_read (
	path      TEXT    PRIMARY KEY,
	event_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bash_failures (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	cmd_signature TEXT    NOT NULL,
	error_summary TEXT    NOT NULL DEFAULT '',
	timestamp     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS working_set (
	key        TEXT PRIMARY KEY,
	value      TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS failure_log (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	tool_name       TEXT    NOT NULL,
	failure_type    TEXT    NOT NULL,
	error_signature TEXT    NOT NULL DEFAULT '',
	file_path       TEXT    NOT NULL DEFAULT '',
	timestamp       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_outcomes (
	tool_name     TEXT    NOT NULL,
	file_path     TEXT    NOT NULL DEFAULT '',
	success_count INTEGER NOT NULL DEFAULT 0,
	failure_count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (tool_name, file_path)
);

CREATE TABLE IF NOT EXISTS tool_sequences (
	bigram_hash  TEXT NOT NULL,
	next_outcome TEXT NOT NULL,
	count        INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (bigram_hash, next_outcome)
);

CREATE TABLE IF NOT EXISTS tool_trigrams (
	trigram_hash TEXT NOT NULL,
	next_outcome TEXT NOT NULL,
	count        INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (trigram_hash, next_outcome)
);

CREATE TABLE IF NOT EXISTS session_phases (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	phase     TEXT NOT NULL,
	tool_name TEXT NOT NULL DEFAULT '',
	timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_change_tracking (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	file_path     TEXT    NOT NULL,
	event_seq     INTEGER NOT NULL,
	lines_added   INTEGER NOT NULL DEFAULT 0,
	lines_removed INTEGER NOT NULL DEFAULT 0,
	net_change    INTEGER NOT NULL DEFAULT 0,
	diff_hash     TEXT    NOT NULL DEFAULT '',
	timestamp     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_cache (
	prompt_hash TEXT PRIMARY KEY,
	response    TEXT NOT NULL,
	model       TEXT NOT NULL DEFAULT '',
	created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`

// HookEvent is a recorded tool event.
type HookEvent struct {
	ID        int64
	ToolName  string
	InputHash uint64
	IsWrite   bool
	Timestamp time.Time
}

// FailureEntry represents a recorded tool failure.
type FailureEntry struct {
	ToolName    string
	FailureType string
	ErrorSig    string
	FilePath    string
	Timestamp   time.Time
}

// Nudge is a queued feedback message for context injection.
type Nudge struct {
	ID          int64
	Pattern     string
	Level       string
	Observation string
	Suggestion  string
	CreatedAt   time.Time
}

// SessionDB wraps an ephemeral per-session SQLite database for hook state.
type SessionDB struct {
	db     *sql.DB
	dbPath string
}

// Open opens (or creates) a session DB for the given session ID.
func Open(sessionID string) (*SessionDB, error) {
	if !validSessionID.MatchString(sessionID) {
		return nil, fmt.Errorf("sessiondb: invalid session ID: %q", sessionID)
	}
	dbPath := DBPath(sessionID)
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("sessiondb: mkdir %s: %w", dir, err)
	}

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return nil, fmt.Errorf("sessiondb: open %s: %w", dbPath, err)
	}

	pragmas := []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA busy_timeout=500",
		"PRAGMA synchronous=NORMAL",
	}
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			db.Close()
			return nil, fmt.Errorf("sessiondb: %s: %w", p, err)
		}
	}

	if _, err := db.Exec(ddl); err != nil {
		db.Close()
		return nil, fmt.Errorf("sessiondb: create tables: %w", err)
	}

	// Initialize burst_state singleton row.
	_, _ = db.Exec(`INSERT OR IGNORE INTO burst_state (id, tool_count, has_write) VALUES (1, 0, 0)`)

	return &SessionDB{db: db, dbPath: dbPath}, nil
}

// DBPath returns the path for a session DB. Panics on invalid session ID.
func DBPath(sessionID string) string {
	if !validSessionID.MatchString(sessionID) {
		panic(fmt.Sprintf("sessiondb: invalid session ID: %q", sessionID))
	}
	tmpDir := os.TempDir()
	return filepath.Join(tmpDir, "claude-buddy", fmt.Sprintf("session-%s.db", sessionID))
}

// Close closes the database connection.
func (s *SessionDB) Close() error {
	return s.db.Close()
}

// Destroy closes and removes the database file.
func (s *SessionDB) Destroy() error {
	if err := s.db.Close(); err != nil {
		return fmt.Errorf("sessiondb: close: %w", err)
	}
	_ = os.Remove(s.dbPath)
	_ = os.Remove(s.dbPath + "-wal")
	_ = os.Remove(s.dbPath + "-shm")
	return nil
}

// RecordEvent records a hook event and updates burst state atomically.
func (s *SessionDB) RecordEvent(toolName string, inputHash uint64, isWrite bool) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("sessiondb: begin tx: %w", err)
	}
	defer tx.Rollback() // no-op after commit

	w := 0
	if isWrite {
		w = 1
	}
	hashHex := fmt.Sprintf("%016x", inputHash)
	if _, err := tx.Exec(
		`INSERT INTO hook_events (tool_name, input_hash, is_write) VALUES (?, ?, ?)`,
		toolName, hashHex, w,
	); err != nil {
		return fmt.Errorf("sessiondb: record event: %w", err)
	}

	if _, err := tx.Exec(`UPDATE burst_state SET tool_count = tool_count + 1 WHERE id = 1`); err != nil {
		return fmt.Errorf("sessiondb: update burst tool_count: %w", err)
	}
	if isWrite {
		if _, err := tx.Exec(`UPDATE burst_state SET has_write = 1 WHERE id = 1`); err != nil {
			return fmt.Errorf("sessiondb: update burst has_write: %w", err)
		}
	}

	return tx.Commit()
}

// IncrementFileRead increments the read count for a file path.
func (s *SessionDB) IncrementFileRead(path string) error {
	_, err := s.db.Exec(
		`INSERT INTO file_reads (path, count) VALUES (?, 1) ON CONFLICT(path) DO UPDATE SET count = count + 1`,
		path,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: increment file read: %w", err)
	}
	return nil
}

// BurstState returns the current burst tracking state.
func (s *SessionDB) BurstState() (toolCount int, hasWrite bool, fileReads map[string]int, err error) {
	var hw int
	err = s.db.QueryRow(`SELECT tool_count, has_write FROM burst_state WHERE id = 1`).Scan(&toolCount, &hw)
	if err != nil {
		return 0, false, nil, fmt.Errorf("sessiondb: burst state: %w", err)
	}
	hasWrite = hw != 0

	fileReads = make(map[string]int)
	rows, err := s.db.Query(`SELECT path, count FROM file_reads`)
	if err != nil {
		return toolCount, hasWrite, nil, fmt.Errorf("sessiondb: file reads: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p string
		var c int
		if err := rows.Scan(&p, &c); err != nil {
			continue
		}
		fileReads[p] = c
	}
	return toolCount, hasWrite, fileReads, rows.Err()
}

// ResetBurst resets burst counters (called on user message boundary).
func (s *SessionDB) ResetBurst() error {
	_, err := s.db.Exec(`UPDATE burst_state SET tool_count = 0, has_write = 0, start_time = datetime('now') WHERE id = 1`)
	if err != nil {
		return fmt.Errorf("sessiondb: reset burst: %w", err)
	}
	_, err = s.db.Exec(`DELETE FROM file_reads`)
	if err != nil {
		return fmt.Errorf("sessiondb: clear file reads: %w", err)
	}
	return nil
}

// SetCooldown sets a cooldown expiry for a pattern.
func (s *SessionDB) SetCooldown(pattern string, duration time.Duration) error {
	expiry := time.Now().Add(duration).UTC().Format(time.RFC3339)
	_, err := s.db.Exec(
		`INSERT INTO cooldowns (pattern, expiry) VALUES (?, ?) ON CONFLICT(pattern) DO UPDATE SET expiry = ?`,
		pattern, expiry, expiry,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: set cooldown: %w", err)
	}
	return nil
}

// IsOnCooldown checks if a pattern is still on cooldown.
func (s *SessionDB) IsOnCooldown(pattern string) (bool, error) {
	var expiry string
	err := s.db.QueryRow(`SELECT expiry FROM cooldowns WHERE pattern = ?`, pattern).Scan(&expiry)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("sessiondb: check cooldown: %w", err)
	}
	t, err := time.Parse(time.RFC3339, expiry)
	if err != nil {
		return false, nil
	}
	return time.Now().Before(t), nil
}

// TrySetCooldown atomically checks if a cooldown has expired and sets a new one.
// Returns true if the cooldown was set (i.e., was not already active).
func (s *SessionDB) TrySetCooldown(pattern string, duration time.Duration) (bool, error) {
	now := time.Now().UTC()
	expiry := now.Add(duration).Format(time.RFC3339)
	nowStr := now.Format(time.RFC3339)

	res, err := s.db.Exec(
		`INSERT INTO cooldowns (pattern, expiry) VALUES (?, ?)
		 ON CONFLICT(pattern) DO UPDATE SET expiry = ?
		 WHERE expiry < ?`,
		pattern, expiry, expiry, nowStr,
	)
	if err != nil {
		return false, fmt.Errorf("sessiondb: try set cooldown: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// RecordCompact records a compaction event.
func (s *SessionDB) RecordCompact() error {
	_, err := s.db.Exec(`INSERT INTO compact_events (timestamp) VALUES (datetime('now'))`)
	if err != nil {
		return fmt.Errorf("sessiondb: record compact: %w", err)
	}
	return nil
}

// CompactsInWindow returns how many compacts occurred in the last N minutes.
func (s *SessionDB) CompactsInWindow(minutes int) (int, error) {
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM compact_events WHERE timestamp > datetime('now', ?)`,
		fmt.Sprintf("-%d minutes", minutes),
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("sessiondb: compacts in window: %w", err)
	}
	return count, nil
}

// EnqueueNudge adds a nudge to the outbox.
func (s *SessionDB) EnqueueNudge(pattern, level, observation, suggestion string) error {
	_, err := s.db.Exec(
		`INSERT INTO nudge_outbox (pattern, level, observation, suggestion) VALUES (?, ?, ?, ?)`,
		pattern, level, observation, suggestion,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: enqueue nudge: %w", err)
	}
	return nil
}

// DequeueNudges atomically selects and marks up to maxN undelivered nudges as delivered.
// Uses BEGIN IMMEDIATE to acquire a write lock before reading, preventing concurrent
// readers from seeing the same undelivered rows.
func (s *SessionDB) DequeueNudges(maxN int) ([]Nudge, error) {
	ctx := context.Background()
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("sessiondb: get conn: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return nil, fmt.Errorf("sessiondb: begin immediate: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			conn.ExecContext(ctx, "ROLLBACK")
		}
	}()

	rows, err := conn.QueryContext(ctx,
		`SELECT id, pattern, level, observation, suggestion, created_at
		 FROM nudge_outbox
		 WHERE delivered_at IS NULL
		 ORDER BY id ASC
		 LIMIT ?`, maxN,
	)
	if err != nil {
		return nil, fmt.Errorf("sessiondb: dequeue nudges: %w", err)
	}

	var nudges []Nudge
	var ids []int64
	for rows.Next() {
		var n Nudge
		var ts string
		if err := rows.Scan(&n.ID, &n.Pattern, &n.Level, &n.Observation, &n.Suggestion, &ts); err != nil {
			continue
		}
		n.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", ts)
		nudges = append(nudges, n)
		ids = append(ids, n.ID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sessiondb: dequeue scan: %w", err)
	}

	for _, id := range ids {
		if _, err := conn.ExecContext(ctx,
			`UPDATE nudge_outbox SET delivered_at = datetime('now') WHERE id = ? AND delivered_at IS NULL`, id,
		); err != nil {
			return nil, fmt.Errorf("sessiondb: mark delivered: %w", err)
		}
	}

	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return nil, fmt.Errorf("sessiondb: commit dequeue: %w", err)
	}
	committed = true
	return nudges, nil
}

// RecentEvents returns the most recent N hook events (newest first).
func (s *SessionDB) RecentEvents(n int) ([]HookEvent, error) {
	rows, err := s.db.Query(
		`SELECT id, tool_name, input_hash, is_write, timestamp
		 FROM hook_events ORDER BY id DESC LIMIT ?`, n,
	)
	if err != nil {
		return nil, fmt.Errorf("sessiondb: recent events: %w", err)
	}
	defer rows.Close()

	var events []HookEvent
	for rows.Next() {
		var ev HookEvent
		var w int
		var ts, hashHex string
		if err := rows.Scan(&ev.ID, &ev.ToolName, &hashHex, &w, &ts); err != nil {
			continue
		}
		ev.InputHash, _ = strconv.ParseUint(hashHex, 16, 64)
		ev.IsWrite = w != 0
		ev.Timestamp, _ = time.Parse("2006-01-02 15:04:05", ts)
		events = append(events, ev)
	}
	return events, rows.Err()
}

// BurstStartTime returns when the current burst started.
func (s *SessionDB) BurstStartTime() (time.Time, error) {
	var ts string
	err := s.db.QueryRow(`SELECT start_time FROM burst_state WHERE id = 1`).Scan(&ts)
	if err != nil {
		return time.Time{}, fmt.Errorf("sessiondb: burst start time: %w", err)
	}
	t, _ := time.Parse("2006-01-02 15:04:05", ts)
	return t, nil
}

// SetContext sets a session context key-value pair.
func (s *SessionDB) SetContext(key, value string) error {
	_, err := s.db.Exec(
		`INSERT INTO session_context (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`,
		key, value, value,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: set context %s: %w", key, err)
	}
	return nil
}

// GetContext returns the value for a session context key. Returns "" if not found.
func (s *SessionDB) GetContext(key string) (string, error) {
	var value string
	err := s.db.QueryRow(`SELECT value FROM session_context WHERE key = ?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("sessiondb: get context %s: %w", key, err)
	}
	return value, nil
}

// RecordFileLastRead records the event sequence number for the last Read of a file.
func (s *SessionDB) RecordFileLastRead(path string, eventSeq int64) error {
	_, err := s.db.Exec(
		`INSERT INTO file_last_read (path, event_seq) VALUES (?, ?)
		 ON CONFLICT(path) DO UPDATE SET event_seq = ?`,
		path, eventSeq, eventSeq,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: record file last read: %w", err)
	}
	return nil
}

// FileLastReadSeq returns the event sequence for the last Read of a file, or 0 if never read.
func (s *SessionDB) FileLastReadSeq(path string) (int64, error) {
	var seq int64
	err := s.db.QueryRow(`SELECT event_seq FROM file_last_read WHERE path = ?`, path).Scan(&seq)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("sessiondb: file last read seq: %w", err)
	}
	return seq, nil
}

// CurrentEventSeq returns the current maximum event ID (used as sequence counter).
func (s *SessionDB) CurrentEventSeq() (int64, error) {
	var seq int64
	err := s.db.QueryRow(`SELECT COALESCE(MAX(id), 0) FROM hook_events`).Scan(&seq)
	if err != nil {
		return 0, fmt.Errorf("sessiondb: current event seq: %w", err)
	}
	return seq, nil
}

// RecordBashFailure records a failed Bash command signature and error summary.
func (s *SessionDB) RecordBashFailure(cmdSignature, errorSummary string) error {
	_, err := s.db.Exec(
		`INSERT INTO bash_failures (cmd_signature, error_summary) VALUES (?, ?)`,
		cmdSignature, errorSummary,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: record bash failure: %w", err)
	}
	return nil
}

// FindSimilarFailure checks if a command signature matches a recent failure.
// Returns the error summary if found, or "" if no match.
func (s *SessionDB) FindSimilarFailure(cmdSignature string) (string, error) {
	var summary string
	err := s.db.QueryRow(
		`SELECT error_summary FROM bash_failures
		 WHERE cmd_signature = ?
		 ORDER BY id DESC LIMIT 1`, cmdSignature,
	).Scan(&summary)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("sessiondb: find similar failure: %w", err)
	}
	return summary, nil
}

// --- Working Set ---

// SetWorkingSet sets a key-value pair in the working set.
func (s *SessionDB) SetWorkingSet(key, value string) error {
	_, err := s.db.Exec(
		`INSERT INTO working_set (key, value, updated_at) VALUES (?, ?, datetime('now'))
		 ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
		key, value, value,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: set working set %s: %w", key, err)
	}
	return nil
}

// GetWorkingSet returns the value for a working set key. Returns "" if not found.
func (s *SessionDB) GetWorkingSet(key string) (string, error) {
	var value string
	err := s.db.QueryRow(`SELECT value FROM working_set WHERE key = ?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("sessiondb: get working set %s: %w", key, err)
	}
	return value, nil
}

// GetAllWorkingSet returns all working set key-value pairs.
func (s *SessionDB) GetAllWorkingSet() (map[string]string, error) {
	rows, err := s.db.Query(`SELECT key, value FROM working_set`)
	if err != nil {
		return nil, fmt.Errorf("sessiondb: get all working set: %w", err)
	}
	defer rows.Close()

	ws := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			continue
		}
		ws[k] = v
	}
	return ws, rows.Err()
}

// AddWorkingSetFile appends a file path to the working set files list.
// Keeps the list capped at 20 entries (newest retained).
func (s *SessionDB) AddWorkingSetFile(path string) error {
	files, _ := s.GetWorkingSetFiles()

	// Deduplicate: remove existing entry if present.
	filtered := make([]string, 0, len(files))
	for _, f := range files {
		if f != path {
			filtered = append(filtered, f)
		}
	}
	filtered = append(filtered, path)

	// Cap at 20, keeping newest.
	if len(filtered) > 20 {
		filtered = filtered[len(filtered)-20:]
	}

	data, err := json.Marshal(filtered)
	if err != nil {
		return fmt.Errorf("sessiondb: marshal working set files: %w", err)
	}
	return s.SetWorkingSet("files_editing", string(data))
}

// GetWorkingSetFiles returns the file paths from the working set.
func (s *SessionDB) GetWorkingSetFiles() ([]string, error) {
	raw, err := s.GetWorkingSet("files_editing")
	if err != nil || raw == "" {
		return nil, err
	}
	var files []string
	if err := json.Unmarshal([]byte(raw), &files); err != nil {
		return nil, nil // corrupted data, treat as empty
	}
	return files, nil
}

// AddWorkingSetDecision appends a decision to the working set decisions list.
// Keeps the list capped at 5 entries (newest retained).
func (s *SessionDB) AddWorkingSetDecision(text string) error {
	decisions, _ := s.GetWorkingSetDecisions()

	// Deduplicate: skip if identical text already exists.
	for _, d := range decisions {
		if d == text {
			return nil
		}
	}
	decisions = append(decisions, text)

	// Cap at 5, keeping newest.
	if len(decisions) > 5 {
		decisions = decisions[len(decisions)-5:]
	}

	data, err := json.Marshal(decisions)
	if err != nil {
		return fmt.Errorf("sessiondb: marshal working set decisions: %w", err)
	}
	return s.SetWorkingSet("decisions", string(data))
}

// GetWorkingSetDecisions returns the decisions from the working set.
func (s *SessionDB) GetWorkingSetDecisions() ([]string, error) {
	raw, err := s.GetWorkingSet("decisions")
	if err != nil || raw == "" {
		return nil, err
	}
	var decisions []string
	if err := json.Unmarshal([]byte(raw), &decisions); err != nil {
		return nil, nil // corrupted data, treat as empty
	}
	return decisions, nil
}

// --- Failure Log ---

// RecordFailure records a tool failure in the failure log.
func (s *SessionDB) RecordFailure(toolName, failureType, errorSig, filePath string) error {
	_, err := s.db.Exec(
		`INSERT INTO failure_log (tool_name, failure_type, error_signature, file_path) VALUES (?, ?, ?, ?)`,
		toolName, failureType, errorSig, filePath,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: record failure: %w", err)
	}
	return nil
}

// RecentFailures returns the most recent N failures (newest first).
func (s *SessionDB) RecentFailures(n int) ([]FailureEntry, error) {
	rows, err := s.db.Query(
		`SELECT tool_name, failure_type, error_signature, file_path, timestamp
		 FROM failure_log ORDER BY id DESC LIMIT ?`, n,
	)
	if err != nil {
		return nil, fmt.Errorf("sessiondb: recent failures: %w", err)
	}
	defer rows.Close()

	var entries []FailureEntry
	for rows.Next() {
		var f FailureEntry
		var ts string
		if err := rows.Scan(&f.ToolName, &f.FailureType, &f.ErrorSig, &f.FilePath, &ts); err != nil {
			continue
		}
		f.Timestamp, _ = time.Parse("2006-01-02 15:04:05", ts)
		entries = append(entries, f)
	}
	return entries, rows.Err()
}

// RecentFailuresForFile returns recent failures for a specific file path.
func (s *SessionDB) RecentFailuresForFile(filePath string, n int) ([]FailureEntry, error) {
	rows, err := s.db.Query(
		`SELECT tool_name, failure_type, error_signature, file_path, timestamp
		 FROM failure_log WHERE file_path = ? ORDER BY id DESC LIMIT ?`, filePath, n,
	)
	if err != nil {
		return nil, fmt.Errorf("sessiondb: recent failures for file: %w", err)
	}
	defer rows.Close()

	var entries []FailureEntry
	for rows.Next() {
		var f FailureEntry
		var ts string
		if err := rows.Scan(&f.ToolName, &f.FailureType, &f.ErrorSig, &f.FilePath, &ts); err != nil {
			continue
		}
		f.Timestamp, _ = time.Parse("2006-01-02 15:04:05", ts)
		entries = append(entries, f)
	}
	return entries, rows.Err()
}

// HasUnresolvedFailure checks if there's a failure for this file with no subsequent success.
func (s *SessionDB) HasUnresolvedFailure(filePath string) (bool, string, error) {
	var failureType string
	err := s.db.QueryRow(
		`SELECT failure_type FROM failure_log
		 WHERE file_path = ? AND timestamp > COALESCE(
		   (SELECT MAX(he.timestamp) FROM hook_events he
		    WHERE he.tool_name IN ('Edit','Write') AND he.is_write = 1),
		   '2000-01-01'
		 )
		 ORDER BY id DESC LIMIT 1`, filePath,
	).Scan(&failureType)
	if err == sql.ErrNoRows {
		return false, "", nil
	}
	if err != nil {
		return false, "", fmt.Errorf("sessiondb: unresolved failure: %w", err)
	}
	return true, failureType, nil
}

// --- Tool Outcomes ---

// RecordToolOutcome records a success or failure for a tool+file combination.
func (s *SessionDB) RecordToolOutcome(toolName, filePath string, succeeded bool) error {
	col := "success_count"
	if !succeeded {
		col = "failure_count"
	}
	_, err := s.db.Exec(
		fmt.Sprintf(
			`INSERT INTO tool_outcomes (tool_name, file_path, %s) VALUES (?, ?, 1)
			 ON CONFLICT(tool_name, file_path) DO UPDATE SET %s = %s + 1`,
			col, col, col,
		),
		toolName, filePath,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: record tool outcome: %w", err)
	}
	return nil
}

// FailureProbability returns the failure rate for a tool+file combination.
// Returns 0 if no data. Only meaningful when total count > minSamples.
func (s *SessionDB) FailureProbability(toolName, filePath string) (prob float64, total int, err error) {
	var sc, fc int
	err = s.db.QueryRow(
		`SELECT success_count, failure_count FROM tool_outcomes WHERE tool_name = ? AND file_path = ?`,
		toolName, filePath,
	).Scan(&sc, &fc)
	if err == sql.ErrNoRows {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, fmt.Errorf("sessiondb: failure probability: %w", err)
	}
	total = sc + fc
	if total == 0 {
		return 0, 0, nil
	}
	return float64(fc) / float64(total), total, nil
}

// --- Tool Sequences ---

// RecordSequence records a tool bigram with its outcome.
func (s *SessionDB) RecordSequence(prevTool, currentTool, outcome string) error {
	hash := prevTool + "→" + currentTool
	_, err := s.db.Exec(
		`INSERT INTO tool_sequences (bigram_hash, next_outcome, count) VALUES (?, ?, 1)
		 ON CONFLICT(bigram_hash, next_outcome) DO UPDATE SET count = count + 1`,
		hash, outcome,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: record sequence: %w", err)
	}
	return nil
}

// --- Tool Trigrams ---

// RecordTrigram records a tool trigram (3-tool sequence) with its outcome.
func (s *SessionDB) RecordTrigram(prevPrev, prev, current, outcome string) error {
	hash := prevPrev + "→" + prev + "→" + current
	_, err := s.db.Exec(
		`INSERT INTO tool_trigrams (trigram_hash, next_outcome, count) VALUES (?, ?, 1)
		 ON CONFLICT(trigram_hash, next_outcome) DO UPDATE SET count = count + 1`,
		hash, outcome,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: record trigram: %w", err)
	}
	return nil
}

// PredictFromTrigram returns the most common outcome for a tool trigram.
// Returns ("", 0) if no data.
func (s *SessionDB) PredictFromTrigram(prevPrev, prev, current string) (outcome string, count int, err error) {
	hash := prevPrev + "→" + prev + "→" + current
	err = s.db.QueryRow(
		`SELECT next_outcome, count FROM tool_trigrams
		 WHERE trigram_hash = ? ORDER BY count DESC LIMIT 1`, hash,
	).Scan(&outcome, &count)
	if err == sql.ErrNoRows {
		return "", 0, nil
	}
	if err != nil {
		return "", 0, fmt.Errorf("sessiondb: predict from trigram: %w", err)
	}
	return outcome, count, nil
}

// --- Session Phases ---

// RecordPhase records a workflow phase transition.
func (s *SessionDB) RecordPhase(phase, toolName string) error {
	_, err := s.db.Exec(
		`INSERT INTO session_phases (phase, tool_name) VALUES (?, ?)`,
		phase, toolName,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: record phase: %w", err)
	}
	return nil
}

// GetPhaseSequence returns the ordered list of phases recorded in this session.
// Adjacent duplicate phases are collapsed (e.g., read,read,write → read,write).
func (s *SessionDB) GetPhaseSequence() ([]string, error) {
	rows, err := s.db.Query(`SELECT phase FROM session_phases ORDER BY id ASC`)
	if err != nil {
		return nil, fmt.Errorf("sessiondb: get phase sequence: %w", err)
	}
	defer rows.Close()

	var phases []string
	var prev string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			continue
		}
		if p != prev {
			phases = append(phases, p)
			prev = p
		}
	}
	return phases, rows.Err()
}

// GetRawPhaseSequence returns the most recent N phases without collapsing duplicates.
func (s *SessionDB) GetRawPhaseSequence(limit int) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT phase FROM (SELECT phase, id FROM session_phases ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("sessiondb: get raw phase sequence: %w", err)
	}
	defer rows.Close()

	var phases []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			continue
		}
		phases = append(phases, p)
	}
	return phases, rows.Err()
}

// PhaseCount returns the total number of phase records in this session.
func (s *SessionDB) PhaseCount() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM session_phases`).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("sessiondb: phase count: %w", err)
	}
	return count, nil
}

// PredictOutcome returns the most common outcome for a tool bigram.
// Returns ("", 0) if no data.
func (s *SessionDB) PredictOutcome(prevTool, currentTool string) (outcome string, count int, err error) {
	hash := prevTool + "→" + currentTool
	err = s.db.QueryRow(
		`SELECT next_outcome, count FROM tool_sequences
		 WHERE bigram_hash = ? ORDER BY count DESC LIMIT 1`, hash,
	).Scan(&outcome, &count)
	if err == sql.ErrNoRows {
		return "", 0, nil
	}
	if err != nil {
		return "", 0, fmt.Errorf("sessiondb: predict outcome: %w", err)
	}
	return outcome, count, nil
}

// PredictNextTool returns the most likely successful next tool after currentTool,
// optionally filtered by task type from session context.
// Returns ("", 0) if no prediction is available.
func (s *SessionDB) PredictNextTool(currentTool string) (nextTool string, count int, err error) {
	rows, err := s.db.Query(
		`SELECT bigram_hash, count FROM tool_sequences
		 WHERE bigram_hash LIKE ? AND next_outcome = 'success'
		 ORDER BY count DESC LIMIT 3`,
		currentTool+"→%",
	)
	if err != nil {
		return "", 0, fmt.Errorf("sessiondb: predict next tool: %w", err)
	}
	defer rows.Close()

	var bestTool string
	var bestCount int
	for rows.Next() {
		var hash string
		var c int
		if err := rows.Scan(&hash, &c); err != nil {
			continue
		}
		parts := splitBigram(hash)
		if parts == "" {
			continue
		}
		if c > bestCount {
			bestTool = parts
			bestCount = c
		}
	}
	return bestTool, bestCount, rows.Err()
}

// splitBigram extracts the second tool name from a "prev→current" bigram hash.
func splitBigram(hash string) string {
	_, after, ok := strings.Cut(hash, "→")
	if !ok || after == "" {
		return ""
	}
	return after
}

// ToolPrediction represents a predicted next tool with its occurrence count and success rate.
type ToolPrediction struct {
	Tool        string
	Count       int
	SuccessRate float64
}

// PredictNextTools returns the most likely next tools after prevTool,
// ranked by occurrence count with success rate. Returns up to limit results.
func (s *SessionDB) PredictNextTools(prevTool string, limit int) ([]ToolPrediction, error) {
	if prevTool == "" || limit <= 0 {
		return nil, nil
	}

	rows, err := s.db.Query(
		`SELECT bigram_hash, next_outcome, SUM(count) as total
		 FROM tool_sequences
		 WHERE bigram_hash LIKE ?
		 GROUP BY bigram_hash, next_outcome
		 ORDER BY total DESC`,
		prevTool+"→%",
	)
	if err != nil {
		return nil, fmt.Errorf("sessiondb: predict next tools: %w", err)
	}
	defer rows.Close()

	// Aggregate success/total per tool.
	type toolStats struct {
		total   int
		success int
	}
	stats := make(map[string]*toolStats)
	for rows.Next() {
		var hash, outcome string
		var count int
		if err := rows.Scan(&hash, &outcome, &count); err != nil {
			continue
		}
		tool := splitBigram(hash)
		if tool == "" {
			continue
		}
		st, ok := stats[tool]
		if !ok {
			st = &toolStats{}
			stats[tool] = st
		}
		st.total += count
		if outcome == "success" {
			st.success += count
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sessiondb: predict next tools scan: %w", err)
	}

	// Convert to sorted slice.
	predictions := make([]ToolPrediction, 0, len(stats))
	for tool, st := range stats {
		rate := 0.0
		if st.total > 0 {
			rate = float64(st.success) / float64(st.total)
		}
		predictions = append(predictions, ToolPrediction{
			Tool:        tool,
			Count:       st.total,
			SuccessRate: rate,
		})
	}

	// Sort by count descending.
	for i := 0; i < len(predictions); i++ {
		for j := i + 1; j < len(predictions); j++ {
			if predictions[j].Count > predictions[i].Count {
				predictions[i], predictions[j] = predictions[j], predictions[i]
			}
		}
	}

	if len(predictions) > limit {
		predictions = predictions[:limit]
	}
	return predictions, nil
}

// --- File Change Tracking ---

// RecordFileChange records a file change event for oscillation/revert detection.
func (s *SessionDB) RecordFileChange(filePath string, eventSeq, linesAdded, linesRemoved int64, diffHash string) error {
	netChange := linesAdded - linesRemoved
	_, err := s.db.Exec(
		`INSERT INTO file_change_tracking (file_path, event_seq, lines_added, lines_removed, net_change, diff_hash)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		filePath, eventSeq, linesAdded, linesRemoved, netChange, diffHash,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: record file change: %w", err)
	}
	return nil
}

// FileEditCount returns the number of recorded edits for a file in this session.
func (s *SessionDB) FileEditCount(filePath string) (int, error) {
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM file_change_tracking WHERE file_path = ?`, filePath,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("sessiondb: file edit count: %w", err)
	}
	return count, nil
}

// DetectOscillation checks if a file's net_change sign has alternated 3+ times,
// indicating the file is being changed back and forth.
func (s *SessionDB) DetectOscillation(filePath string) (bool, error) {
	rows, err := s.db.Query(
		`SELECT net_change FROM file_change_tracking
		 WHERE file_path = ? ORDER BY id DESC LIMIT 6`, filePath,
	)
	if err != nil {
		return false, fmt.Errorf("sessiondb: detect oscillation: %w", err)
	}
	defer rows.Close()

	var changes []int64
	for rows.Next() {
		var nc int64
		if err := rows.Scan(&nc); err != nil {
			continue
		}
		changes = append(changes, nc)
	}
	if len(changes) < 3 {
		return false, nil
	}

	alternations := 0
	for i := 1; i < len(changes); i++ {
		if changes[i-1] != 0 && changes[i] != 0 &&
			(changes[i-1] > 0) != (changes[i] > 0) {
			alternations++
		}
	}
	return alternations >= 3, nil
}

// DetectRevert checks if any diff_hash within a window repeats,
// indicating the same change was applied and then reverted.
func (s *SessionDB) DetectRevert(filePath string, windowSize int) (bool, error) {
	rows, err := s.db.Query(
		`SELECT diff_hash FROM file_change_tracking
		 WHERE file_path = ? AND diff_hash != '' ORDER BY id DESC LIMIT ?`,
		filePath, windowSize,
	)
	if err != nil {
		return false, fmt.Errorf("sessiondb: detect revert: %w", err)
	}
	defer rows.Close()

	seen := make(map[string]bool)
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			continue
		}
		if seen[h] {
			return true, nil
		}
		seen[h] = true
	}
	return false, nil
}

// --- LLM Cache ---

// GetCachedLLMResponse returns a cached LLM response if it exists and is within maxAge.
func (s *SessionDB) GetCachedLLMResponse(promptHash string, maxAge time.Duration) (string, bool) {
	var response, createdAt string
	err := s.db.QueryRow(
		`SELECT response, created_at FROM llm_cache WHERE prompt_hash = ?`, promptHash,
	).Scan(&response, &createdAt)
	if err != nil {
		return "", false
	}
	t, err := time.Parse("2006-01-02 15:04:05", createdAt)
	if err != nil {
		return "", false
	}
	if time.Since(t) > maxAge {
		return "", false
	}
	return response, true
}

// SetCachedLLMResponse stores an LLM response in the cache.
func (s *SessionDB) SetCachedLLMResponse(promptHash, response, model string) error {
	_, err := s.db.Exec(
		`INSERT INTO llm_cache (prompt_hash, response, model) VALUES (?, ?, ?)
		 ON CONFLICT(prompt_hash) DO UPDATE SET response = ?, model = ?, created_at = datetime('now')`,
		promptHash, response, model, response, model,
	)
	if err != nil {
		return fmt.Errorf("sessiondb: set llm cache: %w", err)
	}
	return nil
}
