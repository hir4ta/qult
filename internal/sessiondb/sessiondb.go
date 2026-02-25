package sessiondb

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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
`

// HookEvent is a recorded tool event.
type HookEvent struct {
	ID        int64
	ToolName  string
	InputHash uint64
	IsWrite   bool
	Timestamp time.Time
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
