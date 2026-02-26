package store

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "github.com/ncruces/go-sqlite3/driver"
	_ "github.com/ncruces/go-sqlite3/embed"
)

func setupTestDB(t *testing.T) (*Store, *sql.DB) {
	t.Helper()
	// Use a temp file instead of :memory: so multiple connections from
	// the sql.DB pool share the same database (each :memory: connection
	// is independent and causes nested-query deadlocks).
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	st := &Store{db: db}
	t.Cleanup(func() { db.Close() })
	return st, db
}

func insertTestPattern(t *testing.T, db *sql.DB, sessionID, patternType, title, content, embedText string) {
	t.Helper()
	_, err := db.Exec(`
		INSERT INTO sessions (id, project_path, project_name, jsonl_path)
		VALUES (?, '/test', 'test', '/test.jsonl')
		ON CONFLICT DO NOTHING`, sessionID)
	if err != nil {
		t.Fatalf("insert session: %v", err)
	}
	_, err = db.Exec(`
		INSERT INTO patterns (session_id, pattern_type, title, content, embed_text, scope, timestamp)
		VALUES (?, ?, ?, ?, ?, 'global', datetime('now'))`,
		sessionID, patternType, title, content, embedText)
	if err != nil {
		t.Fatalf("insert pattern: %v", err)
	}
}

func TestSearchPatternsByFTS(t *testing.T) {
	t.Parallel()
	st, db := setupTestDB(t)

	insertTestPattern(t, db, "s1", "error_solution", "Fix nil pointer", "The nil pointer was caused by uninitialized map", "fix nil pointer uninitialized map")
	insertTestPattern(t, db, "s1", "architecture", "Database connection pool", "Use connection pooling for database access", "database connection pool architecture")
	insertTestPattern(t, db, "s1", "error_solution", "Timeout error fix", "Increased timeout to 30 seconds resolved the issue", "timeout error fix increased seconds")

	tests := []struct {
		name        string
		query       string
		patternType string
		wantMin     int
	}{
		{"basic match", "nil pointer", "", 1},
		{"broad query", "database", "", 1},
		{"type filter", "error fix", "error_solution", 1},
		{"type filter excludes", "database", "error_solution", 0},
		{"multi word OR", "timeout nil", "", 2},
		{"no match", "nonexistent xyz", "", 0},
		{"empty query", "", "", 0},
	}

	// Subtests share the same single-connection DB; run sequentially
	// to avoid deadlock from nested queries (getPatternTags/getPatternFiles).
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			results, err := st.SearchPatternsByFTS(tt.query, tt.patternType, 10)
			if err != nil {
				t.Fatalf("SearchPatternsByFTS(%q, %q) error = %v", tt.query, tt.patternType, err)
			}
			if len(results) < tt.wantMin {
				t.Errorf("SearchPatternsByFTS(%q, %q) got %d results, want at least %d", tt.query, tt.patternType, len(results), tt.wantMin)
			}
		})
	}
}

func TestSearchPatternsByKeyword(t *testing.T) {
	t.Parallel()
	st, db := setupTestDB(t)

	insertTestPattern(t, db, "s1", "error_solution", "Fix nil pointer", "The nil pointer was caused by uninitialized map", "fix nil pointer")
	insertTestPattern(t, db, "s1", "architecture", "Database pool", "Use connection pooling for database access", "database pool")

	tests := []struct {
		name        string
		query       string
		patternType string
		wantMin     int
	}{
		{"basic match", "nil pointer", "", 1},
		{"type filter", "database", "architecture", 1},
		{"type filter excludes", "database", "error_solution", 0},
		{"no match", "nonexistent", "", 0},
		{"empty query", "", "", 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			results, err := st.SearchPatternsByKeyword(tt.query, tt.patternType, 10)
			if err != nil {
				t.Fatalf("SearchPatternsByKeyword(%q, %q) error = %v", tt.query, tt.patternType, err)
			}
			if len(results) < tt.wantMin {
				t.Errorf("SearchPatternsByKeyword(%q, %q) got %d results, want at least %d", tt.query, tt.patternType, len(results), tt.wantMin)
			}
		})
	}
}

func TestBuildFTSQuery(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		want  string
	}{
		{"hello world", `"hello" OR "world"`},
		{"nil pointer error", `"nil" OR "pointer" OR "error"`},
		{"", ""},
		{`special "chars" (test)`, `"special" OR "chars" OR "test"`},
		{"single", `"single"`},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			t.Parallel()
			got := buildFTSQuery(tt.input)
			if got != tt.want {
				t.Errorf("buildFTSQuery(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
