package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// Source type constants for the docs table.
const (
	SourceMemory  = "memory"
	SourceSpec    = "spec"
	SourceProject = "project"
)

// DocRow represents a row in the docs table.
type DocRow struct {
	ID          int64
	URL         string
	SectionPath string
	Content     string
	ContentHash string
	SourceType  string // SourceMemory, SourceSpec, SourceProject
	Version     string
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
func (s *Store) UpsertDoc(ctx context.Context, doc *DocRow) (id int64, changed bool, err error) {
	doc.ContentHash = ContentHashOf(doc.Content)
	if doc.CrawledAt == "" {
		doc.CrawledAt = time.Now().UTC().Format(time.RFC3339)
	}
	// TTLDays == 0 means "permanent" (never expires) when set intentionally
	// (e.g., source_type="memory"). Apply default TTL only for source types
	// that expect expiration (docs, project, etc.).
	if doc.TTLDays == 0 && doc.SourceType != SourceMemory {
		doc.TTLDays = 7
	}

	// Check if existing row has same hash (skip update if unchanged).
	var existingID int64
	var existingHash string
	err = s.db.QueryRowContext(ctx,
		`SELECT id, content_hash FROM docs WHERE url = ? AND section_path = ?`,
		doc.URL, doc.SectionPath,
	).Scan(&existingID, &existingHash)
	if err == nil && existingHash == doc.ContentHash {
		return existingID, false, nil
	}

	res, err := s.db.ExecContext(ctx, `
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
		_ = s.db.QueryRowContext(ctx,
			`SELECT id FROM docs WHERE url = ? AND section_path = ?`,
			doc.URL, doc.SectionPath,
		).Scan(&id)
	}
	return id, true, nil
}

// escapeLIKEPrefix escapes LIKE special characters (%, _) in prefix and appends
// the trailing wildcard. Use with ESCAPE '\' clause.
func escapeLIKEPrefix(prefix string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(prefix) + "%"
}

// escapeLIKEContains escapes LIKE special characters and wraps with % for
// substring matching. Use with ESCAPE '\' clause.
func escapeLIKEContains(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(s) + "%"
}

// DeleteDocsByURLPrefix removes all docs (and their embeddings) whose URL starts with the given prefix.
// Returns the number of deleted document rows.
func (s *Store) DeleteDocsByURLPrefix(ctx context.Context, prefix string) (int64, error) {
	if prefix == "" {
		return 0, fmt.Errorf("store: DeleteDocsByURLPrefix: empty prefix")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("store: begin tx: %w", err)
	}
	defer tx.Rollback()

	escaped := escapeLIKEPrefix(prefix)
	_, err = tx.ExecContext(ctx,
		`DELETE FROM embeddings WHERE source = 'docs' AND source_id IN (SELECT id FROM docs WHERE url LIKE ? ESCAPE '\')`, escaped)
	if err != nil {
		return 0, fmt.Errorf("delete embeddings: %w", err)
	}
	res, err := tx.ExecContext(ctx,
		`DELETE FROM docs WHERE url LIKE ? ESCAPE '\'`, escaped)
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
	if prefix == "" {
		return 0, fmt.Errorf("store: CountDocsByURLPrefix: empty prefix")
	}
	var count int64
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM docs WHERE url LIKE ? ESCAPE '\'`, escapeLIKEPrefix(prefix)).Scan(&count)
	return count, err
}

// SearchDocsByURLPrefix returns docs whose URL starts with the given prefix.
// This is an exact prefix match (no tokenization issues).
// Results are ordered by URL for deterministic output.
func (s *Store) SearchDocsByURLPrefix(ctx context.Context, prefix string, limit int) ([]DocRow, error) {
	if prefix == "" {
		return nil, fmt.Errorf("store: SearchDocsByURLPrefix: empty prefix")
	}
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, url, section_path, content, source_type, ttl_days FROM docs WHERE url LIKE ? ESCAPE '\' ORDER BY url LIMIT ?`,
		escapeLIKEPrefix(prefix), limit)
	if err != nil {
		return nil, fmt.Errorf("store: SearchDocsByURLPrefix: %w", err)
	}
	defer rows.Close()
	var docs []DocRow
	for rows.Next() {
		var d DocRow
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.SourceType, &d.TTLDays); err != nil {
			return nil, fmt.Errorf("store: SearchDocsByURLPrefix scan: %w", err)
		}
		docs = append(docs, d)
	}
	return docs, rows.Err()
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
func (s *Store) GetDocsByIDs(ctx context.Context, ids []int64) ([]DocRow, error) {
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

	rows, err := s.db.QueryContext(ctx, query, args...)
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

// SearchMemoriesKeyword searches memory docs using LIKE substring matching.
// This is the fallback when Voyage API is unavailable (no vector search).
// On ~50-500 memory rows, LIKE is fast enough without FTS indexes.
func (s *Store) SearchMemoriesKeyword(ctx context.Context, query string, limit int) ([]DocRow, error) {
	if limit <= 0 {
		limit = 10
	}
	words := strings.Fields(strings.ToLower(query))
	if len(words) == 0 {
		return nil, nil
	}
	// Build WHERE clause: each word must match in section_path OR content.
	var conditions []string
	var args []any
	args = append(args, SourceMemory)
	for _, w := range words {
		escaped := escapeLIKEContains(w)
		conditions = append(conditions, "(LOWER(section_path) LIKE ? ESCAPE '\\' OR LOWER(content) LIKE ? ESCAPE '\\')")
		args = append(args, escaped, escaped)
	}
	sqlQuery := "SELECT id, url, section_path, content, content_hash, source_type, version, crawled_at, ttl_days FROM docs WHERE source_type = ? AND " +
		strings.Join(conditions, " AND ") + " ORDER BY crawled_at DESC LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, sqlQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("store: search memories keyword: %w", err)
	}
	defer rows.Close()
	var docs []DocRow
	for rows.Next() {
		var d DocRow
		var version sql.NullString
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash, &d.SourceType, &version, &d.CrawledAt, &d.TTLDays); err != nil {
			continue
		}
		d.Version = version.String
		docs = append(docs, d)
	}
	return docs, rows.Err()
}
