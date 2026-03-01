package store

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
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

// GetDoc retrieves a single doc by ID.
func (s *Store) GetDoc(id int64) (*DocRow, error) {
	var d DocRow
	var version sql.NullString
	err := s.db.QueryRow(`
		SELECT id, url, section_path, content, content_hash, source_type, version, crawled_at, ttl_days
		FROM docs WHERE id = ?`, id,
	).Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash,
		&d.SourceType, &version, &d.CrawledAt, &d.TTLDays)
	if err != nil {
		return nil, err
	}
	d.Version = version.String
	return &d, nil
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

// SearchDocsFTS searches the docs table using FTS5 full-text search.
// Returns results ranked by BM25 relevance.
func (s *Store) SearchDocsFTS(query string, sourceType string, limit int) ([]DocRow, error) {
	if limit <= 0 {
		limit = 10
	}

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

// SearchDocsLIKE searches docs using LIKE as a last-resort fallback.
func (s *Store) SearchDocsLIKE(query string, limit int) ([]DocRow, error) {
	if limit <= 0 {
		limit = 10
	}

	rows, err := s.db.Query(`
		SELECT id, url, section_path, content, content_hash, source_type, version, crawled_at, ttl_days
		FROM docs
		WHERE content LIKE ? OR section_path LIKE ?
		ORDER BY crawled_at DESC
		LIMIT ?`,
		"%"+query+"%", "%"+query+"%", limit,
	)
	if err != nil {
		return nil, fmt.Errorf("store: search docs like: %w", err)
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

// DeleteExpiredDocs removes docs whose TTL has expired.
func (s *Store) DeleteExpiredDocs() (int64, error) {
	res, err := s.db.Exec(`
		DELETE FROM docs
		WHERE julianday('now') - julianday(crawled_at) > ttl_days`)
	if err != nil {
		return 0, fmt.Errorf("store: delete expired docs: %w", err)
	}
	// Also clean up orphaned embeddings.
	s.db.Exec(`DELETE FROM embeddings WHERE source = 'docs' AND source_id NOT IN (SELECT id FROM docs)`)
	return res.RowsAffected()
}

// DocsStats returns summary statistics about the docs table.
func (s *Store) DocsStats() (total int, bySource map[string]int, lastCrawl string, err error) {
	bySource = make(map[string]int)
	rows, err := s.db.Query(`SELECT source_type, COUNT(*) FROM docs GROUP BY source_type`)
	if err != nil {
		return 0, nil, "", err
	}
	defer rows.Close()
	for rows.Next() {
		var st string
		var count int
		if rows.Scan(&st, &count) == nil {
			bySource[st] = count
			total += count
		}
	}
	s.db.QueryRow(`SELECT MAX(crawled_at) FROM docs`).Scan(&lastCrawl)
	return total, bySource, lastCrawl, nil
}
