package store

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// DocRow represents a row in the docs table.
type DocRow struct {
	ID          int64
	URL         string
	SectionPath string
	Content     string
	ContentHash string
	SourceType  string // "docs", "changelog", "engineering"
	Version     string // CLI version (changelog only)
	CrawledAt   string
	TTLDays     int
}

// DocsCount returns the total number of rows in the docs table.
func (s *Store) DocsCount() (int, error) {
	var n int
	err := s.db.QueryRow("SELECT COUNT(*) FROM docs").Scan(&n)
	return n, err
}

// ContentHashOf returns the SHA-256 hex hash of content for change detection.
func ContentHashOf(content string) string {
	h := sha256.Sum256([]byte(content))
	return fmt.Sprintf("%x", h)
}

// UpsertDoc inserts or updates a doc section. Returns the row ID and whether
// the content was actually changed (false if hash matched existing row).
func (s *Store) UpsertDoc(doc *DocRow) (id int64, changed bool, err error) {
	doc.ContentHash = ContentHashOf(doc.Content)
	if doc.CrawledAt == "" {
		doc.CrawledAt = time.Now().UTC().Format(time.RFC3339)
	}
	if doc.TTLDays == 0 {
		doc.TTLDays = 7
	}

	// Check if existing row has same hash (skip update if unchanged).
	var existingID int64
	var existingHash string
	err = s.db.QueryRow(
		`SELECT id, content_hash FROM docs WHERE url = ? AND section_path = ?`,
		doc.URL, doc.SectionPath,
	).Scan(&existingID, &existingHash)
	if err == nil && existingHash == doc.ContentHash {
		return existingID, false, nil
	}

	res, err := s.db.Exec(`
		INSERT INTO docs (url, section_path, content, content_hash, source_type, version, crawled_at, ttl_days)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(url, section_path) DO UPDATE SET
			content = excluded.content,
			content_hash = excluded.content_hash,
			source_type = excluded.source_type,
			version = excluded.version,
			crawled_at = excluded.crawled_at,
			ttl_days = excluded.ttl_days`,
		doc.URL, doc.SectionPath, doc.Content, doc.ContentHash,
		doc.SourceType, doc.Version, doc.CrawledAt, doc.TTLDays,
	)
	if err != nil {
		return 0, false, fmt.Errorf("store: upsert doc: %w", err)
	}

	id, _ = res.LastInsertId()
	if id == 0 {
		// ON CONFLICT UPDATE doesn't set LastInsertId; re-query.
		_ = s.db.QueryRow(
			`SELECT id FROM docs WHERE url = ? AND section_path = ?`,
			doc.URL, doc.SectionPath,
		).Scan(&id)
	}
	return id, true, nil
}

// GetDocsByIDs retrieves multiple docs by their IDs.
func (s *Store) GetDocsByIDs(ids []int64) ([]DocRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	// Build query with placeholders.
	query := "SELECT id, url, section_path, content, content_hash, source_type, version, crawled_at, ttl_days FROM docs WHERE id IN ("
	args := make([]any, len(ids))
	for i, id := range ids {
		if i > 0 {
			query += ","
		}
		query += "?"
		args[i] = id
	}
	query += ")"

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("store: get docs by ids: %w", err)
	}
	defer rows.Close()

	var docs []DocRow
	for rows.Next() {
		var d DocRow
		var version sql.NullString
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash,
			&d.SourceType, &version, &d.CrawledAt, &d.TTLDays); err != nil {
			continue
		}
		d.Version = version.String
		docs = append(docs, d)
	}
	return docs, nil
}

// fts5SpecialChars are characters with special meaning in FTS5 MATCH syntax.
var fts5Replacer = strings.NewReplacer(
	`"`, " ", `(`, " ", `)`, " ",
	`*`, " ", `+`, " ", `^`, " ",
	`:`, " ", `{`, " ", `}`, " ",
)

// fts5Reserved are FTS5 boolean operators that must be removed from user queries.
var fts5Reserved = map[string]bool{
	"AND": true, "OR": true, "NOT": true, "NEAR": true,
}

// SanitizeFTS5Query strips FTS5 special characters and reserved words from a
// user query. Short single-word queries (3-6 chars) get prefix expansion.
// Returns "" if the sanitized query is empty.
func SanitizeFTS5Query(query string) string {
	q := fts5Replacer.Replace(query)
	words := strings.Fields(q)
	filtered := words[:0]
	for _, w := range words {
		w = strings.TrimLeft(w, "-")
		if w == "" || fts5Reserved[strings.ToUpper(w)] {
			continue
		}
		filtered = append(filtered, w)
	}
	if len(filtered) == 0 {
		return ""
	}
	if len(filtered) == 1 && len(filtered[0]) >= 3 && len(filtered[0]) <= 6 {
		return filtered[0] + "*"
	}
	return strings.Join(filtered, " ")
}

// SearchDocsFTS searches the docs table using FTS5 full-text search.
// Multi-word queries use phrase-first matching with OR fallback.
func (s *Store) SearchDocsFTS(rawQuery string, sourceType string, limit int) ([]DocRow, error) {
	if limit <= 0 {
		limit = 10
	}
	query := SanitizeFTS5Query(rawQuery)
	if query == "" {
		return nil, nil
	}

	words := strings.Fields(query)
	// Multi-word: try phrase match first, then OR fallback.
	if len(words) > 1 {
		phraseQuery := `"` + strings.Join(words, " ") + `"`
		results, err := s.matchDocsFTS(phraseQuery, sourceType, limit)
		if err == nil && len(results) > 0 {
			return results, nil
		}
		query = strings.Join(words, " OR ")
	}
	return s.matchDocsFTS(query, sourceType, limit)
}

// matchDocsFTS executes a FTS5 MATCH query against the docs_fts table.
func (s *Store) matchDocsFTS(query string, sourceType string, limit int) ([]DocRow, error) {
	var sqlQuery string
	var args []any

	if sourceType != "" {
		sqlQuery = `
			SELECT d.id, d.url, d.section_path, d.content, d.content_hash,
			       d.source_type, d.version, d.crawled_at, d.ttl_days
			FROM docs_fts f
			JOIN docs d ON d.id = f.rowid
			WHERE docs_fts MATCH ? AND d.source_type = ?
			ORDER BY rank
			LIMIT ?`
		args = []any{query, sourceType, limit}
	} else {
		sqlQuery = `
			SELECT d.id, d.url, d.section_path, d.content, d.content_hash,
			       d.source_type, d.version, d.crawled_at, d.ttl_days
			FROM docs_fts f
			JOIN docs d ON d.id = f.rowid
			WHERE docs_fts MATCH ?
			ORDER BY rank
			LIMIT ?`
		args = []any{query, limit}
	}

	rows, err := s.db.Query(sqlQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("store: search docs fts: %w", err)
	}
	defer rows.Close()

	var docs []DocRow
	for rows.Next() {
		var d DocRow
		var version sql.NullString
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash,
			&d.SourceType, &version, &d.CrawledAt, &d.TTLDays); err != nil {
			continue
		}
		d.Version = version.String
		docs = append(docs, d)
	}
	return docs, nil
}

