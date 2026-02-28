package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	_ "github.com/ncruces/go-sqlite3/driver"
	_ "github.com/ncruces/go-sqlite3/embed"
)

// Store wraps a SQLite database connection.
type Store struct {
	db     *sql.DB
	dbPath string
}

// Open opens (or creates) a SQLite database at dbPath,
// enables WAL mode and foreign keys, then runs migrations.
func Open(dbPath string) (*Store, error) {
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("store: mkdir %s: %w", dir, err)
	}

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return nil, fmt.Errorf("store: open %s: %w", dbPath, err)
	}

	pragmas := []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA foreign_keys=ON",
	}
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			db.Close()
			return nil, fmt.Errorf("store: %s: %w", p, err)
		}
	}

	if err := Migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("store: migrate: %w", err)
	}

	st := &Store{db: db, dbPath: dbPath}

	// Seed knowledge patterns for cold-start users.
	if err := SeedIfEmpty(st); err != nil {
		fmt.Fprintf(os.Stderr, "[buddy] seed patterns: %v\n", err)
	}

	return st, nil
}

// OpenDefault opens the database at the default path (~/.claude-buddy/buddy.db).
func OpenDefault() (*Store, error) {
	return Open(DefaultDBPath())
}

var (
	defaultCached    *Store
	defaultCachedErr error
	defaultOnce      sync.Once
)

// OpenDefaultCached returns a process-level cached store connection.
// Intended for short-lived hook-handler processes where opening the DB
// once per process is sufficient. Do NOT call Close() on the returned Store.
func OpenDefaultCached() (*Store, error) {
	defaultOnce.Do(func() {
		defaultCached, defaultCachedErr = Open(DefaultDBPath())
	})
	return defaultCached, defaultCachedErr
}

// Close closes the underlying database connection.
func (s *Store) Close() error {
	return s.db.Close()
}

// DB returns the underlying *sql.DB for direct queries.
func (s *Store) DB() *sql.DB {
	return s.db
}

// DefaultDBPath returns ~/.claude-buddy/buddy.db.
func DefaultDBPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".claude-buddy", "buddy.db")
}
