package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// Source type constants for the records table.
const (
	SourceMemory  = "memory"
	SourceSpec    = "spec"
	SourceProject = "project"
)

// SubType constants for memory classification.
const (
	SubTypeGeneral  = "general"
	SubTypeDecision = "decision"
	SubTypePattern  = "pattern"
	SubTypeRule     = "rule"
)

// DocRow represents a row in the records table.
type DocRow struct {
	ID           int64
	URL          string
	SectionPath  string
	Content      string
	ContentHash  string
	SourceType   string // SourceMemory, SourceSpec, SourceProject
	SubType      string // SubTypeGeneral, SubTypeDecision, SubTypePattern, SubTypeRule
	Version      string
	CrawledAt    string
	TTLDays      int
	HitCount     int
	LastAccessed string
	Structured   string
}

// Promotion thresholds: minimum hit_count to qualify as a promotion candidate.
const (
	PromoteToPatternHits = 5  // general → pattern
	PromoteToRuleHits    = 15 // pattern → rule
)

// ContentHashOf returns the SHA-256 hex hash of content for change detection.
func ContentHashOf(content string) string {
	h := sha256.Sum256([]byte(content))
	return fmt.Sprintf("%x", h)
}

// UpsertDoc inserts or updates a record. Returns the row ID and whether
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
	if doc.SubType == "" {
		doc.SubType = SubTypeGeneral
	}

	// Check if existing row has same hash (skip update if unchanged).
	var existingID int64
	var existingHash string
	err = s.db.QueryRowContext(ctx,
		`SELECT id, content_hash FROM records WHERE url = ? AND section_path = ?`,
		doc.URL, doc.SectionPath,
	).Scan(&existingID, &existingHash)
	if err == nil && existingHash == doc.ContentHash {
		return existingID, false, nil
	}

	res, err := s.db.ExecContext(ctx, `
		INSERT INTO records (url, section_path, content, content_hash, source_type, sub_type, version, crawled_at, ttl_days, structured)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(url, section_path) DO UPDATE SET
			content = excluded.content,
			content_hash = excluded.content_hash,
			source_type = excluded.source_type,
			sub_type = excluded.sub_type,
			version = excluded.version,
			crawled_at = excluded.crawled_at,
			ttl_days = excluded.ttl_days,
			structured = excluded.structured`,
		doc.URL, doc.SectionPath, doc.Content, doc.ContentHash,
		doc.SourceType, doc.SubType, doc.Version, doc.CrawledAt, doc.TTLDays, doc.Structured,
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
			`SELECT id FROM records WHERE url = ? AND section_path = ?`,
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

// DeleteDocsByURLPrefix removes all records (and their embeddings) whose URL starts with the given prefix.
// Returns the number of deleted record rows.
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
		`DELETE FROM embeddings WHERE source = 'records' AND source_id IN (SELECT id FROM records WHERE url LIKE ? ESCAPE '\')`, escaped)
	if err != nil {
		return 0, fmt.Errorf("delete embeddings: %w", err)
	}
	res, err := tx.ExecContext(ctx,
		`DELETE FROM records WHERE url LIKE ? ESCAPE '\'`, escaped)
	if err != nil {
		return 0, fmt.Errorf("delete records: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: delete records rows affected: %w", err)
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
		`SELECT COUNT(*) FROM records WHERE url LIKE ? ESCAPE '\'`, escapeLIKEPrefix(prefix)).Scan(&count)
	return count, err
}

// SearchDocsByURLPrefix returns records whose URL starts with the given prefix.
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
		`SELECT id, url, section_path, content, source_type, sub_type, ttl_days, structured FROM records WHERE url LIKE ? ESCAPE '\' ORDER BY url LIMIT ?`,
		escapeLIKEPrefix(prefix), limit)
	if err != nil {
		return nil, fmt.Errorf("store: SearchDocsByURLPrefix: %w", err)
	}
	defer rows.Close()
	var docs []DocRow
	for rows.Next() {
		var d DocRow
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.SourceType, &d.SubType, &d.TTLDays, &d.Structured); err != nil {
			return nil, fmt.Errorf("store: SearchDocsByURLPrefix scan: %w", err)
		}
		docs = append(docs, d)
	}
	return docs, rows.Err()
}

// DeleteExpiredDocs removes records whose TTL has expired based on crawled_at + ttl_days.
// Returns the number of deleted rows.
func (s *Store) DeleteExpiredDocs(ctx context.Context) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("store: begin tx: %w", err)
	}
	defer tx.Rollback()

	// Delete associated embeddings first.
	_, err = tx.ExecContext(ctx,
		`DELETE FROM embeddings WHERE source = 'records' AND source_id IN (
			SELECT id FROM records WHERE ttl_days > 0
			AND datetime(crawled_at, '+' || ttl_days || ' days') < datetime('now')
		)`)
	if err != nil {
		return 0, fmt.Errorf("store: delete expired embeddings: %w", err)
	}

	res, err := tx.ExecContext(ctx,
		`DELETE FROM records WHERE ttl_days > 0
		AND datetime(crawled_at, '+' || ttl_days || ' days') < datetime('now')`)
	if err != nil {
		return 0, fmt.Errorf("store: delete expired records: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: expired records rows affected: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("store: commit expired delete: %w", err)
	}
	return n, nil
}

// GetDocsByIDs retrieves multiple records by their IDs.
func (s *Store) GetDocsByIDs(ctx context.Context, ids []int64) ([]DocRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	// Build query with placeholders.
	query := "SELECT id, url, section_path, content, content_hash, source_type, sub_type, version, crawled_at, ttl_days, hit_count, structured FROM records WHERE id IN ("
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
			&d.SourceType, &d.SubType, &version, &d.CrawledAt, &d.TTLDays, &d.HitCount, &d.Structured); err != nil {
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

// SearchMemoriesKeyword searches memory records using LIKE substring matching.
// This is the fallback when Voyage API is unavailable (no vector search).
// On ~50-500 memory rows, LIKE is fast enough without FTS indexes.
func (s *Store) SearchMemoriesKeyword(ctx context.Context, query string, limit int) ([]DocRow, error) {
	if limit <= 0 {
		limit = 10
	}
	words := strings.Fields(strings.ToLower(query))
	// Build WHERE clause: each word must match in section_path OR content.
	var conditions []string
	var args []any
	args = append(args, SourceMemory)
	for _, w := range words {
		escaped := escapeLIKEContains(w)
		conditions = append(conditions, "(LOWER(section_path) LIKE ? ESCAPE '\\' OR LOWER(content) LIKE ? ESCAPE '\\')")
		args = append(args, escaped, escaped)
	}
	where := "source_type = ?"
	if len(conditions) > 0 {
		where += " AND " + strings.Join(conditions, " AND ")
	}
	sqlQuery := "SELECT id, url, section_path, content, content_hash, source_type, sub_type, version, crawled_at, ttl_days, hit_count, structured FROM records WHERE " +
		where + " ORDER BY crawled_at DESC LIMIT ?"
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
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash, &d.SourceType, &d.SubType, &version, &d.CrawledAt, &d.TTLDays, &d.HitCount, &d.Structured); err != nil {
			continue
		}
		d.Version = version.String
		docs = append(docs, d)
	}
	return docs, rows.Err()
}

// ListRecentMemories returns the most recent memory records, ordered by crawled_at desc.
func (s *Store) ListRecentMemories(ctx context.Context, limit int) ([]DocRow, error) {
	if limit <= 0 {
		limit = 50
	}
	sqlQuery := `SELECT id, url, section_path, content, content_hash, source_type, sub_type,
		version, crawled_at, ttl_days, hit_count, structured
		FROM records WHERE source_type = ? ORDER BY crawled_at DESC LIMIT ?`
	rows, err := s.db.QueryContext(ctx, sqlQuery, SourceMemory, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list recent memories: %w", err)
	}
	defer rows.Close()
	var docs []DocRow
	for rows.Next() {
		var d DocRow
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash,
			&d.SourceType, &d.SubType, &d.Version, &d.CrawledAt, &d.TTLDays,
			&d.HitCount, &d.Structured); err != nil {
			continue
		}
		docs = append(docs, d)
	}
	return docs, rows.Err()
}

// IncrementHitCount atomically increments hit_count and updates last_accessed
// for the given record IDs. Uses a single batch UPDATE for efficiency.
func (s *Store) IncrementHitCount(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339)

	placeholders := make([]string, len(ids))
	args := make([]any, 0, len(ids)+1)
	args = append(args, now)
	for i, id := range ids {
		placeholders[i] = "?"
		args = append(args, id)
	}
	query := fmt.Sprintf(
		`UPDATE records SET hit_count = hit_count + 1, last_accessed = ? WHERE id IN (%s)`,
		strings.Join(placeholders, ","),
	)
	_, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("store: increment hit count: %w", err)
	}
	return nil
}

// PromoteSubType updates the sub_type of a memory record.
// Only allows valid promotion paths: general→pattern, pattern→rule.
func (s *Store) PromoteSubType(ctx context.Context, id int64, newSubType string) error {
	if newSubType != SubTypePattern && newSubType != SubTypeRule {
		return fmt.Errorf("store: invalid promotion target %q: must be pattern or rule", newSubType)
	}

	var current string
	err := s.db.QueryRowContext(ctx,
		`SELECT sub_type FROM records WHERE id = ? AND source_type = ?`,
		id, SourceMemory).Scan(&current)
	if err != nil {
		return fmt.Errorf("store: promote sub_type: record %d not found or not a memory: %w", id, err)
	}

	switch {
	case current == SubTypeGeneral && newSubType == SubTypePattern:
		// OK
	case current == SubTypePattern && newSubType == SubTypeRule:
		// OK
	default:
		return fmt.Errorf("store: invalid promotion path %s → %s", current, newSubType)
	}

	_, err = s.db.ExecContext(ctx,
		`UPDATE records SET sub_type = ? WHERE id = ?`, newSubType, id)
	if err != nil {
		return fmt.Errorf("store: promote sub_type: %w", err)
	}
	return nil
}

// GetPromotionCandidates returns memory records whose hit_count exceeds
// the promotion threshold for their current sub_type.
// decision sub_type is excluded (not promotable).
func (s *Store) GetPromotionCandidates(ctx context.Context) ([]DocRow, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, url, section_path, content, content_hash, source_type, sub_type,
		        version, crawled_at, ttl_days, hit_count, last_accessed, structured
		 FROM records
		 WHERE source_type = ?
		   AND ((sub_type = ? AND hit_count >= ?) OR (sub_type = ? AND hit_count >= ?))
		 ORDER BY hit_count DESC`,
		SourceMemory,
		SubTypeGeneral, PromoteToPatternHits,
		SubTypePattern, PromoteToRuleHits,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get promotion candidates: %w", err)
	}
	defer rows.Close()

	var docs []DocRow
	for rows.Next() {
		var d DocRow
		var version sql.NullString
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash,
			&d.SourceType, &d.SubType, &version, &d.CrawledAt, &d.TTLDays,
			&d.HitCount, &d.LastAccessed, &d.Structured); err != nil {
			continue
		}
		d.Version = version.String
		docs = append(docs, d)
	}
	return docs, rows.Err()
}

// MemoryStats holds aggregate statistics about memory records.
type MemoryStats struct {
	Total       int
	BySubType   map[string]int
	AvgHitCount float64
	TopAccessed []DocRow
}

// GetMemoryStats returns aggregate statistics about memory records.
func (s *Store) GetMemoryStats(ctx context.Context) (*MemoryStats, error) {
	stats := &MemoryStats{BySubType: make(map[string]int)}

	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*), COALESCE(AVG(hit_count), 0) FROM records WHERE source_type = ?`,
		SourceMemory).Scan(&stats.Total, &stats.AvgHitCount)
	if err != nil {
		return nil, fmt.Errorf("store: get memory stats: %w", err)
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT sub_type, COUNT(*) FROM records WHERE source_type = ? GROUP BY sub_type`,
		SourceMemory)
	if err != nil {
		return nil, fmt.Errorf("store: get memory stats by sub_type: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var st string
		var count int
		if err := rows.Scan(&st, &count); err != nil {
			continue
		}
		stats.BySubType[st] = count
	}

	topRows, err := s.db.QueryContext(ctx,
		`SELECT id, url, section_path, content, source_type, sub_type, hit_count, last_accessed
		 FROM records WHERE source_type = ? AND hit_count > 0
		 ORDER BY hit_count DESC LIMIT 5`, SourceMemory)
	if err != nil {
		return stats, nil
	}
	defer topRows.Close()
	for topRows.Next() {
		var d DocRow
		if err := topRows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content,
			&d.SourceType, &d.SubType, &d.HitCount, &d.LastAccessed); err != nil {
			continue
		}
		stats.TopAccessed = append(stats.TopAccessed, d)
	}
	return stats, nil
}

// GetStaleMemories returns memory records that haven't been accessed
// within staleDays. For records with no last_accessed, crawled_at is used.
func (s *Store) GetStaleMemories(ctx context.Context, staleDays int) ([]DocRow, error) {
	if staleDays <= 0 {
		staleDays = 90
	}
	cutoff := time.Now().AddDate(0, 0, -staleDays).UTC().Format(time.RFC3339)

	rows, err := s.db.QueryContext(ctx,
		`SELECT id, url, section_path, content, source_type, sub_type, hit_count, last_accessed, crawled_at, structured
		 FROM records
		 WHERE source_type = ?
		   AND CASE WHEN last_accessed != '' THEN last_accessed < ? ELSE crawled_at < ? END
		 ORDER BY hit_count ASC, crawled_at ASC
		 LIMIT 50`,
		SourceMemory, cutoff, cutoff)
	if err != nil {
		return nil, fmt.Errorf("store: get stale memories: %w", err)
	}
	defer rows.Close()

	var docs []DocRow
	for rows.Next() {
		var d DocRow
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content,
			&d.SourceType, &d.SubType, &d.HitCount, &d.LastAccessed, &d.CrawledAt, &d.Structured); err != nil {
			continue
		}
		docs = append(docs, d)
	}
	return docs, rows.Err()
}
