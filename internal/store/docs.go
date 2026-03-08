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

// Source type constants for the docs table.
const (
	SourceDocs        = "docs"
	SourceMemory      = "memory"
	SourceSpec        = "spec"
	SourceProject     = "project"
	SourceChangelog   = "changelog"
	SourceEngineering = "engineering"
)

// LastCrawledAt returns the most recent crawled_at timestamp for seed docs.
// Returns zero time if no docs exist.
func (s *Store) LastCrawledAt() (time.Time, error) {
	var crawledAt string
	err := s.db.QueryRow(
		`SELECT crawled_at FROM docs WHERE source_type = 'docs' ORDER BY crawled_at DESC LIMIT 1`,
	).Scan(&crawledAt)
	if err != nil {
		return time.Time{}, err
	}
	return time.Parse(time.RFC3339, crawledAt)
}

// DocRow represents a row in the docs table.
type DocRow struct {
	ID          int64
	URL         string
	SectionPath string
	Content     string
	ContentHash string
	SourceType  string // SourceDocs, SourceMemory, SourceSpec, etc.
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

	// Best-effort orphan cleanup: remove doc_feedback rows for deleted docs.
	// Error is non-fatal; the transaction commit will catch corruption.
	_, _ = tx.ExecContext(ctx,
		`DELETE FROM doc_feedback WHERE NOT EXISTS (SELECT 1 FROM docs WHERE docs.id = doc_feedback.doc_id)`)

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

// CrawlMeta represents HTTP caching metadata for a URL.
type CrawlMeta struct {
	URL           string
	ETag          string
	LastModified  string
	LastCrawledAt string
}

// GetCrawlMeta retrieves HTTP caching metadata for the given URL.
// Returns nil (not an error) if no metadata exists.
func (s *Store) GetCrawlMeta(ctx context.Context, url string) (*CrawlMeta, error) {
	var m CrawlMeta
	err := s.db.QueryRowContext(ctx,
		`SELECT url, etag, last_modified, last_crawled_at FROM crawl_meta WHERE url = ?`, url,
	).Scan(&m.URL, &m.ETag, &m.LastModified, &m.LastCrawledAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("store: get crawl meta: %w", err)
	}
	return &m, nil
}

// UpsertCrawlMeta inserts or updates HTTP caching metadata for a URL.
func (s *Store) UpsertCrawlMeta(ctx context.Context, meta *CrawlMeta) error {
	if meta.LastCrawledAt == "" {
		meta.LastCrawledAt = time.Now().UTC().Format(time.RFC3339)
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO crawl_meta (url, etag, last_modified, last_crawled_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(url) DO UPDATE SET
			etag = excluded.etag,
			last_modified = excluded.last_modified,
			last_crawled_at = excluded.last_crawled_at`,
		meta.URL, meta.ETag, meta.LastModified, meta.LastCrawledAt,
	)
	if err != nil {
		return fmt.Errorf("store: upsert crawl meta: %w", err)
	}
	return nil
}

// RecordInjection saves which doc IDs were injected, so the next prompt
// can evaluate whether the injection was useful (implicit feedback).
func (s *Store) RecordInjection(ctx context.Context, docIDs []int64) error {
	now := time.Now().UTC().Format(time.RFC3339)
	for _, id := range docIDs {
		_, err := s.db.ExecContext(ctx, `
			INSERT INTO doc_feedback (doc_id, last_injected)
			VALUES (?, ?)
			ON CONFLICT(doc_id) DO UPDATE SET last_injected = excluded.last_injected`,
			id, now,
		)
		if err != nil {
			return fmt.Errorf("store: record injection: %w", err)
		}
	}
	return nil
}

// RecordFeedback increments the positive or negative hit count for a doc.
func (s *Store) RecordFeedback(ctx context.Context, docID int64, positive bool) error {
	now := time.Now().UTC().Format(time.RFC3339)
	var err error
	if positive {
		_, err = s.db.ExecContext(ctx, `
			UPDATE doc_feedback SET positive_hits = positive_hits + 1, last_feedback = ?
			WHERE doc_id = ?`, now, docID)
	} else {
		_, err = s.db.ExecContext(ctx, `
			UPDATE doc_feedback SET negative_hits = negative_hits + 1, last_feedback = ?
			WHERE doc_id = ?`, now, docID)
	}
	return err
}

// GetRecentInjections returns doc IDs injected within the last duration.
func (s *Store) GetRecentInjections(ctx context.Context, within time.Duration) ([]int64, error) {
	cutoff := time.Now().Add(-within).UTC().Format(time.RFC3339)
	rows, err := s.db.QueryContext(ctx,
		`SELECT doc_id FROM doc_feedback WHERE last_injected > ? ORDER BY last_injected DESC LIMIT 20`,
		cutoff,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			continue
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// FeedbackBoost returns a relevance boost factor for a doc based on accumulated
// feedback signals. Returns 1.0 (neutral) if no feedback exists.
// Positive-heavy docs get up to +0.1 boost; negative-heavy get up to -0.1 penalty.
func (s *Store) FeedbackBoost(ctx context.Context, docID int64) float64 {
	m := s.FeedbackBoostBatch(ctx, []int64{docID})
	if v, ok := m[docID]; ok {
		return v
	}
	return 1.0
}

// FeedbackBoostBatch returns relevance boost factors for multiple docs in a
// single query. Missing entries default to 1.0 (neutral).
func (s *Store) FeedbackBoostBatch(ctx context.Context, docIDs []int64) map[int64]float64 {
	result := make(map[int64]float64, len(docIDs))
	if len(docIDs) == 0 {
		return result
	}

	query := "SELECT doc_id, positive_hits, negative_hits FROM doc_feedback WHERE doc_id IN ("
	args := make([]any, len(docIDs))
	for i, id := range docIDs {
		if i > 0 {
			query += ","
		}
		query += "?"
		args[i] = id
	}
	query += ")"

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return result
	}
	defer rows.Close()

	for rows.Next() {
		var docID int64
		var pos, neg int
		if err := rows.Scan(&docID, &pos, &neg); err != nil {
			continue
		}
		total := pos + neg
		if total == 0 {
			continue
		}
		ratio := float64(pos-neg) / float64(total)
		result[docID] = 1.0 + ratio*0.1
	}
	return result
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

// SanitizeFTS5Term sanitizes a single FTS5 term by removing non-token
// characters and FTS5 reserved words. Returns "" if the term is empty.
func SanitizeFTS5Term(term string) string {
	var buf strings.Builder
	for _, r := range term {
		if isFTS5TokenChar(r) {
			buf.WriteRune(r)
		} else {
			buf.WriteByte(' ')
		}
	}
	words := strings.Fields(buf.String())
	filtered := words[:0]
	for _, w := range words {
		if !fts5Reserved[strings.ToUpper(w)] {
			filtered = append(filtered, w)
		}
	}
	return strings.Join(filtered, " ")
}

// JoinFTS5Terms sanitizes individual terms and joins them with OR.
// Returns "" if no valid terms remain after sanitization.
func JoinFTS5Terms(terms []string) string {
	var sanitized []string
	for _, t := range terms {
		s := SanitizeFTS5Term(t)
		if s != "" {
			sanitized = append(sanitized, s)
		}
	}
	if len(sanitized) == 0 {
		return ""
	}
	return strings.Join(sanitized, " OR ")
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
func (s *Store) SearchDocsFTS(ctx context.Context, rawQuery string, sourceType string, limit int) ([]DocRow, error) {
	if limit <= 0 {
		limit = 10
	}

	// Translate Japanese terms to English before sanitizing.
	translated := TranslateQuery(rawQuery)
	query := SanitizeFTS5Query(translated)
	if query == "" {
		return nil, nil
	}

	results, err := s.searchFTS(ctx, query, sourceType, limit)
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
	return s.searchFTS(ctx, corrected, sourceType, limit)
}

// searchFTS executes phrase-first then OR-fallback FTS5 search.
func (s *Store) searchFTS(ctx context.Context, query string, sourceType string, limit int) ([]DocRow, error) {
	words := strings.Fields(query)
	if len(words) > 1 {
		phraseQuery := `"` + strings.Join(words, " ") + `"`
		results, err := s.matchDocsFTS(ctx, phraseQuery, sourceType, limit)
		if err == nil && len(results) > 0 {
			return results, nil
		}
		query = strings.Join(words, " OR ")
	}
	return s.matchDocsFTS(ctx, query, sourceType, limit)
}

// matchDocsFTS executes a FTS5 MATCH query against the docs_fts table.
// sourceType supports: single value ("docs"), comma-separated ("docs,memory"), or empty (all types).
func (s *Store) matchDocsFTS(ctx context.Context, query string, sourceType string, limit int) ([]DocRow, error) {
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

	rows, err := s.db.QueryContext(ctx, sqlQuery, args...)
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

// CountDocsBySourceType returns the number of documents with the given source type.
func (s *Store) CountDocsBySourceType(ctx context.Context, sourceType string) (int64, error) {
	var count int64
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM docs WHERE source_type = ?`, sourceType).Scan(&count)
	return count, err
}

// CountDocsBySourceTypeAndAge returns the number of documents with the given
// source type whose crawled_at is before the cutoff time.
func (s *Store) CountDocsBySourceTypeAndAge(ctx context.Context, sourceType, cutoff string) (int64, error) {
	var count int64
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM docs WHERE source_type = ? AND crawled_at < ?`,
		sourceType, cutoff).Scan(&count)
	return count, err
}

// MemoryListItem represents a memory entry for display purposes.
type MemoryListItem struct {
	SectionPath string
	CrawledAt   string
}

// ListMemoriesBefore returns memory entries older than the cutoff, up to limit.
func (s *Store) ListMemoriesBefore(ctx context.Context, cutoff string, limit int) ([]MemoryListItem, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT section_path, crawled_at FROM docs
		 WHERE source_type = 'memory' AND crawled_at < ?
		 ORDER BY crawled_at ASC LIMIT ?`, cutoff, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []MemoryListItem
	for rows.Next() {
		var item MemoryListItem
		if rows.Scan(&item.SectionPath, &item.CrawledAt) == nil {
			items = append(items, item)
		}
	}
	return items, rows.Err()
}

// DeleteMemoriesBefore removes memory docs older than cutoff along with their
// embeddings and doc_feedback in a single transaction.
func (s *Store) DeleteMemoriesBefore(ctx context.Context, cutoff string) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("store: begin tx: %w", err)
	}
	defer tx.Rollback()

	// Delete associated embeddings first.
	_, err = tx.ExecContext(ctx,
		`DELETE FROM embeddings WHERE source = 'docs' AND source_id IN (
			SELECT id FROM docs WHERE source_type = 'memory' AND crawled_at < ?)`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("store: delete memory embeddings: %w", err)
	}

	// Best-effort: clean doc_feedback for these docs.
	_, _ = tx.ExecContext(ctx,
		`DELETE FROM doc_feedback WHERE doc_id IN (
			SELECT id FROM docs WHERE source_type = 'memory' AND crawled_at < ?)`, cutoff)

	res, err := tx.ExecContext(ctx,
		`DELETE FROM docs WHERE source_type = 'memory' AND crawled_at < ?`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("store: delete memories: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: memory delete rows affected: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("store: commit memory delete: %w", err)
	}
	return n, nil
}

// MemoryProjectStat holds per-project memory counts.
type MemoryProjectStat struct {
	Project string
	Count   int
	Oldest  string
	Newest  string
}

// MemoryStatsByProject returns memory counts grouped by project.
// Pass limit <= 0 for no limit.
func (s *Store) MemoryStatsByProject(ctx context.Context, limit int) ([]MemoryProjectStat, error) {
	if limit <= 0 {
		limit = -1 // SQLite: LIMIT -1 returns all rows
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT SUBSTR(section_path, 1, INSTR(section_path, ' > ')-1) AS project, COUNT(*) AS cnt,
		        MIN(crawled_at) AS oldest, MAX(crawled_at) AS newest
		 FROM docs WHERE source_type = 'memory'
		 GROUP BY project ORDER BY cnt DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var stats []MemoryProjectStat
	for rows.Next() {
		var s MemoryProjectStat
		if rows.Scan(&s.Project, &s.Count, &s.Oldest, &s.Newest) == nil && s.Project != "" {
			stats = append(stats, s)
		}
	}
	return stats, rows.Err()
}

// ExportDoc represents a document for export purposes.
type ExportDoc struct {
	URL         string
	SectionPath string
	Content     string
	SourceType  string
	CrawledAt   string
}

// DocOrderBy defines valid ORDER BY clauses for document queries.
type DocOrderBy string

const (
	OrderByCrawledAtDesc DocOrderBy = "crawled_at DESC"
	OrderByURL           DocOrderBy = "url ASC"
)

// QueryDocsBySourceType returns all documents of the given source type.
func (s *Store) QueryDocsBySourceType(ctx context.Context, sourceType string, orderBy DocOrderBy) ([]ExportDoc, error) {
	if orderBy == "" {
		orderBy = OrderByCrawledAtDesc
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT url, section_path, content, source_type, crawled_at
		 FROM docs WHERE source_type = ? ORDER BY `+string(orderBy), sourceType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var docs []ExportDoc
	for rows.Next() {
		var d ExportDoc
		if err := rows.Scan(&d.URL, &d.SectionPath, &d.Content, &d.SourceType, &d.CrawledAt); err != nil {
			continue
		}
		docs = append(docs, d)
	}
	return docs, rows.Err()
}

