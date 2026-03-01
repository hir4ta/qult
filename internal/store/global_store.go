package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const globalSchemaVersion = 1

const globalDDL = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cross_project_patterns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_project  TEXT NOT NULL,
    pattern_type    TEXT NOT NULL,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    keywords        TEXT,
    effectiveness   REAL DEFAULT 0.5,
    times_applied   INTEGER DEFAULT 0,
    times_effective INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cpp_type ON cross_project_patterns(pattern_type);
CREATE INDEX IF NOT EXISTS idx_cpp_effectiveness ON cross_project_patterns(effectiveness DESC);

CREATE TABLE IF NOT EXISTS project_fingerprints (
    project_path    TEXT PRIMARY KEY,
    project_name    TEXT,
    languages       TEXT,
    domains         TEXT,
    frameworks      TEXT,
    total_sessions  INTEGER DEFAULT 0,
    last_active_at  TEXT DEFAULT (datetime('now'))
);
`

// GlobalStore wraps a SQLite database for cross-project knowledge.
type GlobalStore struct {
	db     *sql.DB
	dbPath string
}

// OpenGlobal opens (or creates) the global database at ~/.claude-alfred/global.db.
func OpenGlobal() (*GlobalStore, error) {
	dbPath := GlobalDBPath()
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("global store: mkdir %s: %w", dir, err)
	}

	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return nil, fmt.Errorf("global store: open %s: %w", dbPath, err)
	}

	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		db.Close()
		return nil, fmt.Errorf("global store: WAL: %w", err)
	}

	if err := migrateGlobal(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("global store: migrate: %w", err)
	}

	return &GlobalStore{db: db, dbPath: dbPath}, nil
}

// Close closes the global database connection.
func (g *GlobalStore) Close() error {
	return g.db.Close()
}

// GlobalDBPath returns the default global DB path.
func GlobalDBPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".claude-alfred", "global.db")
}

func migrateGlobal(db *sql.DB) error {
	var ver int
	err := db.QueryRow("SELECT version FROM schema_version LIMIT 1").Scan(&ver)
	if err != nil {
		// Fresh DB.
		if _, err := db.Exec(globalDDL); err != nil {
			return fmt.Errorf("create schema: %w", err)
		}
		_, err = db.Exec("INSERT INTO schema_version (version) VALUES (?)", globalSchemaVersion)
		return err
	}
	// Already at current version.
	return nil
}

// CrossProjectPattern represents a reusable pattern from another project.
type CrossProjectPattern struct {
	ID            int64
	SourceProject string
	PatternType   string
	Title         string
	Content       string
	Keywords      []string
	Effectiveness float64
	TimesApplied  int
}

// InsertPattern adds a cross-project pattern to the global DB.
func (g *GlobalStore) InsertPattern(sourceProject, patternType, title, content string, keywords []string) error {
	kw := strings.Join(keywords, ",")
	_, err := g.db.Exec(
		`INSERT INTO cross_project_patterns (source_project, pattern_type, title, content, keywords)
		 VALUES (?, ?, ?, ?, ?)`,
		sourceProject, patternType, title, content, kw,
	)
	if err != nil {
		return fmt.Errorf("global store: insert pattern: %w", err)
	}
	return nil
}

// SearchPatterns searches cross-project patterns by keyword and type.
func (g *GlobalStore) SearchPatterns(query string, patternType string, limit int) ([]CrossProjectPattern, error) {
	if limit < 1 {
		limit = 5
	}

	var where []string
	var args []any

	if query != "" {
		where = append(where, "(title LIKE ? OR content LIKE ? OR keywords LIKE ?)")
		q := "%" + query + "%"
		args = append(args, q, q, q)
	}
	if patternType != "" {
		where = append(where, "pattern_type = ?")
		args = append(args, patternType)
	}

	sql := "SELECT id, source_project, pattern_type, title, content, keywords, effectiveness, times_applied FROM cross_project_patterns"
	if len(where) > 0 {
		sql += " WHERE " + strings.Join(where, " AND ")
	}
	sql += " ORDER BY effectiveness DESC, times_applied DESC LIMIT ?"
	args = append(args, limit)

	rows, err := g.db.Query(sql, args...)
	if err != nil {
		return nil, fmt.Errorf("global store: search patterns: %w", err)
	}
	defer rows.Close()

	var results []CrossProjectPattern
	for rows.Next() {
		var p CrossProjectPattern
		var kw string
		if err := rows.Scan(&p.ID, &p.SourceProject, &p.PatternType, &p.Title, &p.Content, &kw, &p.Effectiveness, &p.TimesApplied); err != nil {
			continue
		}
		if kw != "" {
			p.Keywords = strings.Split(kw, ",")
		}
		results = append(results, p)
	}
	return results, rows.Err()
}

// ProjectFingerprint represents a project's characteristics.
type ProjectFingerprint struct {
	ProjectPath string
	ProjectName string
	Languages   []string
	Domains     []string
	Frameworks  []string
	Sessions    int
}

// UpsertFingerprint inserts or updates a project fingerprint.
func (g *GlobalStore) UpsertFingerprint(fp *ProjectFingerprint) error {
	langs := strings.Join(fp.Languages, ",")
	domains := strings.Join(fp.Domains, ",")
	frameworks := strings.Join(fp.Frameworks, ",")
	_, err := g.db.Exec(
		`INSERT INTO project_fingerprints (project_path, project_name, languages, domains, frameworks, total_sessions)
		 VALUES (?, ?, ?, ?, ?, 1)
		 ON CONFLICT(project_path) DO UPDATE SET
		     languages = ?,
		     domains = ?,
		     frameworks = ?,
		     total_sessions = total_sessions + 1,
		     last_active_at = datetime('now')`,
		fp.ProjectPath, fp.ProjectName, langs, domains, frameworks,
		langs, domains, frameworks,
	)
	if err != nil {
		return fmt.Errorf("global store: upsert fingerprint: %w", err)
	}
	return nil
}

// FindSimilarProjects finds projects that share languages or frameworks.
func (g *GlobalStore) FindSimilarProjects(fp *ProjectFingerprint, limit int) ([]ProjectFingerprint, error) {
	if limit < 1 {
		limit = 5
	}

	// Match by any shared language or framework.
	var conditions []string
	var args []any
	for _, lang := range fp.Languages {
		conditions = append(conditions, "languages LIKE ?")
		args = append(args, "%"+lang+"%")
	}
	for _, fw := range fp.Frameworks {
		conditions = append(conditions, "frameworks LIKE ?")
		args = append(args, "%"+fw+"%")
	}
	if len(conditions) == 0 {
		return nil, nil
	}

	query := fmt.Sprintf(
		`SELECT project_path, project_name, languages, domains, frameworks, total_sessions
		 FROM project_fingerprints
		 WHERE project_path != ? AND (%s)
		 ORDER BY total_sessions DESC LIMIT ?`,
		strings.Join(conditions, " OR "),
	)
	args = append([]any{fp.ProjectPath}, args...)
	args = append(args, limit)

	rows, err := g.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("global store: find similar: %w", err)
	}
	defer rows.Close()

	var results []ProjectFingerprint
	for rows.Next() {
		var p ProjectFingerprint
		var langs, domains, frameworks string
		if err := rows.Scan(&p.ProjectPath, &p.ProjectName, &langs, &domains, &frameworks, &p.Sessions); err != nil {
			continue
		}
		if langs != "" {
			p.Languages = strings.Split(langs, ",")
		}
		if domains != "" {
			p.Domains = strings.Split(domains, ",")
		}
		if frameworks != "" {
			p.Frameworks = strings.Split(frameworks, ",")
		}
		results = append(results, p)
	}
	return results, rows.Err()
}
