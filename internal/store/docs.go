package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"strings"
	"time"
	"unicode"
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

// SeedDocsCount returns the number of seed docs (source_type != 'project').
func (s *Store) SeedDocsCount() (int, error) {
	var n int
	err := s.db.QueryRow("SELECT COUNT(*) FROM docs WHERE source_type != 'project'").Scan(&n)
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
	// TTLDays == 0 means "permanent" (never expires) when set intentionally
	// (e.g., source_type="memory"). Apply default TTL only for source types
	// that expect expiration (docs, project, etc.).
	if doc.TTLDays == 0 && doc.SourceType != "memory" {
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

	// LastInsertId may return 0 on ON CONFLICT UPDATE; error is non-critical
	// since the row was successfully written — ID is best-effort for embeddings.
	id, _ = res.LastInsertId()
	if id == 0 {
		// Re-query to get the ID; Scan error means row exists but ID lookup
		// failed — acceptable since the upsert itself succeeded.
		_ = s.db.QueryRow(
			`SELECT id FROM docs WHERE url = ? AND section_path = ?`,
			doc.URL, doc.SectionPath,
		).Scan(&id)
	}
	return id, true, nil
}

// DeleteDocsByURLPrefix removes all docs (and their embeddings) whose URL starts with the given prefix.
// Returns the number of deleted document rows.
func (s *Store) DeleteDocsByURLPrefix(ctx context.Context, prefix string) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("store: begin tx: %w", err)
	}
	defer tx.Rollback()

	_, err = tx.ExecContext(ctx,
		`DELETE FROM embeddings WHERE source = 'docs' AND source_id IN (SELECT id FROM docs WHERE url LIKE ? || '%')`, prefix)
	if err != nil {
		return 0, fmt.Errorf("delete embeddings: %w", err)
	}
	res, err := tx.ExecContext(ctx,
		`DELETE FROM docs WHERE url LIKE ? || '%'`, prefix)
	if err != nil {
		return 0, fmt.Errorf("delete docs: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: delete docs rows affected: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("store: commit delete: %w", err)
	}
	return n, nil
}

// CountDocsByURLPrefix returns the number of documents matching the given URL prefix.
func (s *Store) CountDocsByURLPrefix(ctx context.Context, prefix string) (int64, error) {
	var count int64
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM docs WHERE url LIKE ? || '%'`, prefix).Scan(&count)
	return count, err
}

// DeleteExpiredDocs removes docs whose TTL has expired based on crawled_at + ttl_days.
// Returns the number of deleted rows.
func (s *Store) DeleteExpiredDocs(ctx context.Context) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("store: begin tx: %w", err)
	}
	defer tx.Rollback()

	// Delete associated embeddings first.
	_, err = tx.ExecContext(ctx,
		`DELETE FROM embeddings WHERE source = 'docs' AND source_id IN (
			SELECT id FROM docs WHERE ttl_days > 0
			AND datetime(crawled_at, '+' || ttl_days || ' days') < datetime('now')
		)`)
	if err != nil {
		return 0, fmt.Errorf("store: delete expired embeddings: %w", err)
	}

	res, err := tx.ExecContext(ctx,
		`DELETE FROM docs WHERE ttl_days > 0
		AND datetime(crawled_at, '+' || ttl_days || ' days') < datetime('now')`)
	if err != nil {
		return 0, fmt.Errorf("store: delete expired docs: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: expired docs rows affected: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("store: commit expired delete: %w", err)
	}
	return n, nil
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
			if DebugLog != nil {
				DebugLog("store: GetDocsByIDs scan error: %v", err)
			}
			continue // skip malformed rows; query itself succeeded
		}
		d.Version = version.String
		docs = append(docs, d)
	}
	if err := rows.Err(); err != nil {
		return docs, fmt.Errorf("store: get docs by ids iteration: %w", err)
	}
	return docs, nil
}

// isFTS5TokenChar reports whether r is a token character under the unicode61
// tokenizer's default configuration (categories L*, N*, Co).
// Everything else is a separator.
func isFTS5TokenChar(r rune) bool {
	return unicode.In(r, unicode.Letter, unicode.Number, unicode.Co)
}

// fts5Reserved are FTS5 boolean operators that must be removed from user queries.
var fts5Reserved = map[string]bool{
	"AND": true, "OR": true, "NOT": true, "NEAR": true,
}

// SanitizeFTS5Query converts user input into safe FTS5 MATCH tokens.
// Non-token characters (per unicode61 rules) become word boundaries.
// Short single-word queries (3-6 chars) get prefix expansion.
// Returns "" if the sanitized query is empty.
func SanitizeFTS5Query(query string) string {
	var buf strings.Builder
	buf.Grow(len(query))
	for _, r := range query {
		if isFTS5TokenChar(r) {
			buf.WriteRune(r)
		} else {
			buf.WriteByte(' ')
		}
	}

	words := strings.Fields(buf.String())
	filtered := words[:0]
	for _, w := range words {
		if fts5Reserved[strings.ToUpper(w)] {
			continue
		}
		filtered = append(filtered, w)
	}
	if len(filtered) == 0 {
		return ""
	}
	// Single short words get prefix expansion for broader recall.
	// Range [3,6]: <3 is too short (noise), >6 is specific enough without wildcard.
	if len(filtered) == 1 && len(filtered[0]) >= 3 && len(filtered[0]) <= 6 {
		return filtered[0] + "*"
	}
	return strings.Join(filtered, " ")
}

// SearchDocsFTS searches the docs table using FTS5 full-text search.
// Multi-word queries use phrase-first matching with OR fallback.
// Automatically translates Japanese terms and corrects typos when
// the initial query returns no results.
func (s *Store) SearchDocsFTS(rawQuery string, sourceType string, limit int) ([]DocRow, error) {
	if limit <= 0 {
		limit = 10
	}

	// Translate Japanese terms to English before sanitizing.
	translated := TranslateQuery(rawQuery)
	query := SanitizeFTS5Query(translated)
	if query == "" {
		return nil, nil
	}

	results, err := s.searchFTS(query, sourceType, limit)
	if err != nil {
		return nil, err
	}
	if len(results) > 0 {
		return results, nil
	}

	// No results: try typo correction.
	corrected := s.CorrectTypos(query)
	if corrected == query {
		return nil, nil
	}
	return s.searchFTS(corrected, sourceType, limit)
}

// searchFTS executes phrase-first then OR-fallback FTS5 search.
func (s *Store) searchFTS(query string, sourceType string, limit int) ([]DocRow, error) {
	words := strings.Fields(query)
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
// sourceType supports: single value ("docs"), comma-separated ("docs,memory"), or empty (all types).
func (s *Store) matchDocsFTS(query string, sourceType string, limit int) ([]DocRow, error) {
	var sqlQuery string
	var args []any

	types := parseSourceTypes(sourceType)
	switch len(types) {
	case 0:
		sqlQuery = `
			SELECT d.id, d.url, d.section_path, d.content, d.content_hash,
			       d.source_type, d.version, d.crawled_at, d.ttl_days
			FROM docs_fts f
			JOIN docs d ON d.id = f.rowid
			WHERE docs_fts MATCH ?
			ORDER BY rank
			LIMIT ?`
		args = []any{query, limit}
	case 1:
		sqlQuery = `
			SELECT d.id, d.url, d.section_path, d.content, d.content_hash,
			       d.source_type, d.version, d.crawled_at, d.ttl_days
			FROM docs_fts f
			JOIN docs d ON d.id = f.rowid
			WHERE docs_fts MATCH ? AND d.source_type = ?
			ORDER BY rank
			LIMIT ?`
		args = []any{query, types[0], limit}
	default:
		placeholders := make([]string, len(types))
		args = []any{query}
		for i, t := range types {
			placeholders[i] = "?"
			args = append(args, t)
		}
		sqlQuery = `
			SELECT d.id, d.url, d.section_path, d.content, d.content_hash,
			       d.source_type, d.version, d.crawled_at, d.ttl_days
			FROM docs_fts f
			JOIN docs d ON d.id = f.rowid
			WHERE docs_fts MATCH ? AND d.source_type IN (` + strings.Join(placeholders, ",") + `)
			ORDER BY rank
			LIMIT ?`
		args = append(args, limit)
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
			if DebugLog != nil {
				DebugLog("store: SearchDocsFTS scan error: %v", err)
			}
			continue // skip malformed rows; query itself succeeded
		}
		d.Version = version.String
		docs = append(docs, d)
	}
	if err := rows.Err(); err != nil {
		return docs, fmt.Errorf("store: search docs fts iteration: %w", err)
	}
	return docs, nil
}

// parseSourceTypes splits a comma-separated source_type string into individual types.
// Returns nil for empty input (meaning "all types").
func parseSourceTypes(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	types := parts[:0]
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			types = append(types, p)
		}
	}
	return types
}

