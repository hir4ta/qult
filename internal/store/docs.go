package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"math"
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
	Enabled      bool
	ValidUntil   string // RFC3339 datetime; empty = no expiry
	ReviewBy     string // RFC3339 datetime; empty = no review deadline
	SupersededBy int64  // ID of newer version; 0 = current version
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

	// Convert empty strings to nil for nullable columns.
	var validUntil, reviewBy any
	if doc.ValidUntil != "" {
		validUntil = doc.ValidUntil
	}
	if doc.ReviewBy != "" {
		reviewBy = doc.ReviewBy
	}

	res, err := s.db.ExecContext(ctx, `
		INSERT INTO records (url, section_path, content, content_hash, source_type, sub_type, version, crawled_at, ttl_days, structured, valid_until, review_by)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(url, section_path) DO UPDATE SET
			content = excluded.content,
			content_hash = excluded.content_hash,
			source_type = excluded.source_type,
			sub_type = excluded.sub_type,
			version = excluded.version,
			crawled_at = excluded.crawled_at,
			ttl_days = excluded.ttl_days,
			structured = excluded.structured,
			valid_until = excluded.valid_until,
			review_by = excluded.review_by`,
		doc.URL, doc.SectionPath, doc.Content, doc.ContentHash,
		doc.SourceType, doc.SubType, doc.Version, doc.CrawledAt, doc.TTLDays, doc.Structured,
		validUntil, reviewBy,
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
	where := "source_type = ? AND enabled = 1 AND (valid_until IS NULL OR valid_until > datetime('now')) AND superseded_by IS NULL"
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

// ListRecentMemories returns the most recent enabled memory records, ordered by crawled_at desc.
func (s *Store) ListRecentMemories(ctx context.Context, limit int) ([]DocRow, error) {
	if limit <= 0 {
		limit = 50
	}
	sqlQuery := `SELECT id, url, section_path, content, content_hash, source_type, sub_type,
		version, crawled_at, ttl_days, hit_count, structured
		FROM records WHERE source_type = ? AND enabled = 1
		AND (valid_until IS NULL OR valid_until > datetime('now'))
		AND superseded_by IS NULL
		ORDER BY crawled_at DESC LIMIT ?`
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
		d.Enabled = true // filtered by WHERE enabled = 1
		docs = append(docs, d)
	}
	return docs, rows.Err()
}

// SetEnabled toggles the enabled status of a memory record.
// Scoped to source_type=memory to prevent accidental disabling of spec/project records.
func (s *Store) SetEnabled(ctx context.Context, id int64, enabled bool) error {
	val := 0
	if enabled {
		val = 1
	}
	_, err := s.db.ExecContext(ctx, `UPDATE records SET enabled = ? WHERE id = ? AND source_type = ?`, val, id, SourceMemory)
	return err
}

// ListAllMemories returns recent memories including disabled ones, with enabled status.
func (s *Store) ListAllMemories(ctx context.Context, limit int) ([]DocRow, error) {
	if limit <= 0 {
		limit = 50
	}
	sqlQuery := `SELECT id, url, section_path, content, content_hash, source_type, sub_type,
		version, crawled_at, ttl_days, hit_count, structured, enabled
		FROM records WHERE source_type = ? ORDER BY crawled_at DESC LIMIT ?`
	rows, err := s.db.QueryContext(ctx, sqlQuery, SourceMemory, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list all memories: %w", err)
	}
	defer rows.Close()
	var docs []DocRow
	for rows.Next() {
		var d DocRow
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash,
			&d.SourceType, &d.SubType, &d.Version, &d.CrawledAt, &d.TTLDays,
			&d.HitCount, &d.Structured, &d.Enabled); err != nil {
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

	staleRows, err := s.db.QueryContext(ctx,
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
	defer staleRows.Close()

	var docs []DocRow
	for staleRows.Next() {
		var d DocRow
		if err := staleRows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content,
			&d.SourceType, &d.SubType, &d.HitCount, &d.LastAccessed, &d.CrawledAt, &d.Structured); err != nil {
			continue
		}
		docs = append(docs, d)
	}
	return docs, staleRows.Err()
}

// VitalityScore holds the computed vitality components for a memory.
type VitalityScore struct {
	Total           float64 `json:"total"`            // 0-100
	RecencyDecay    float64 `json:"recency_decay"`    // 0-1.0
	HitCountScore   float64 `json:"hit_count_score"`  // 0-1.0 (capped at 50 hits)
	SubTypeWeight   float64 `json:"sub_type_weight"`  // 0-1.0 (normalized boost)
	AccessFrequency float64 `json:"access_frequency"` // 0-1.0 (hits per day, bounded)
}

// vitalityHitCap is the maximum hit_count contribution ceiling.
const vitalityHitCap = 50.0

// ComputeVitalityFromDoc calculates vitality from a DocRow without DB access.
// Used by both ComputeVitality and ListLowVitality.
func ComputeVitalityFromDoc(d *DocRow, now time.Time) VitalityScore {
	// 1. Recency decay component (0.5 to 1.0).
	halfLife := SubTypeHalfLife(d.SubType)
	var recencyDecay float64 = 1.0
	if t, err := time.Parse(time.RFC3339, d.CrawledAt); err == nil {
		ageDays := now.Sub(t).Hours() / 24
		if ageDays > 0 && halfLife > 0 {
			recencyDecay = math.Exp(-math.Ln2 * ageDays / halfLife)
			if recencyDecay < 0.5 {
				recencyDecay = 0.5
			}
		}
	}

	// 2. Hit count component (0-1.0, capped at 50 hits).
	hitScore := math.Min(float64(d.HitCount), vitalityHitCap) / vitalityHitCap

	// 3. Sub-type weight component (normalized: general=0, rule=1.0).
	// SubTypeBoost range: 1.0 (general) to 2.0 (rule). Normalize to 0-1.
	subTypeWeight := SubTypeBoost(d.SubType) - 1.0

	// 4. Access frequency component (hits per day, bounded 0-1).
	var accessFreq float64
	if t, err := time.Parse(time.RFC3339, d.CrawledAt); err == nil {
		ageDays := math.Max(now.Sub(t).Hours()/24, 1.0)
		accessFreq = math.Min(float64(d.HitCount)/ageDays, 1.0)
	}

	total := 100.0 * (0.40*recencyDecay + 0.25*hitScore + 0.20*subTypeWeight + 0.15*accessFreq)

	return VitalityScore{
		Total:           total,
		RecencyDecay:    recencyDecay,
		HitCountScore:   hitScore,
		SubTypeWeight:   subTypeWeight,
		AccessFrequency: accessFreq,
	}
}

// ComputeVitality calculates the composite vitality score for a memory record.
// Returns an error if the record is not found or is not a memory.
func (s *Store) ComputeVitality(ctx context.Context, recordID int64) (*VitalityScore, error) {
	var d DocRow
	var version sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT id, url, section_path, content, content_hash, source_type, sub_type,
			version, crawled_at, ttl_days, hit_count, last_accessed
		 FROM records WHERE id = ?`, recordID).Scan(
		&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash,
		&d.SourceType, &d.SubType, &version, &d.CrawledAt, &d.TTLDays,
		&d.HitCount, &d.LastAccessed)
	if err != nil {
		return nil, fmt.Errorf("store: compute vitality: record %d not found: %w", recordID, err)
	}
	d.Version = version.String

	if d.SourceType != SourceMemory {
		return nil, fmt.Errorf("store: compute vitality: record %d is not a memory (source_type=%s)", recordID, d.SourceType)
	}

	vs := ComputeVitalityFromDoc(&d, time.Now())
	return &vs, nil
}

// LowVitalityDoc pairs a DocRow with its computed vitality score.
type LowVitalityDoc struct {
	DocRow
	Vitality float64 `json:"vitality"`
}

// ListLowVitality returns enabled memory records with vitality below threshold,
// sorted by vitality ascending. Only computes vitality for source_type=memory.
func (s *Store) ListLowVitality(ctx context.Context, threshold float64, limit int) ([]LowVitalityDoc, error) {
	if threshold <= 0 {
		threshold = 20.0
	}
	if limit <= 0 {
		limit = 50
	}

	lvRows, err := s.db.QueryContext(ctx,
		`SELECT id, url, section_path, content, content_hash, source_type, sub_type,
			version, crawled_at, ttl_days, hit_count, last_accessed
		 FROM records
		 WHERE source_type = ? AND enabled = 1
		   AND (valid_until IS NULL OR valid_until > datetime('now'))
		   AND superseded_by IS NULL
		 ORDER BY crawled_at ASC`,
		SourceMemory)
	if err != nil {
		return nil, fmt.Errorf("store: list low vitality: %w", err)
	}
	defer lvRows.Close()

	now := time.Now()
	var results []LowVitalityDoc
	for lvRows.Next() {
		var d DocRow
		var version sql.NullString
		if err := lvRows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash,
			&d.SourceType, &d.SubType, &version, &d.CrawledAt, &d.TTLDays,
			&d.HitCount, &d.LastAccessed); err != nil {
			continue
		}
		d.Version = version.String

		vs := ComputeVitalityFromDoc(&d, now)
		if vs.Total < threshold {
			results = append(results, LowVitalityDoc{DocRow: d, Vitality: vs.Total})
			if len(results) >= limit {
				break
			}
		}
	}
	if err := lvRows.Err(); err != nil {
		return results, fmt.Errorf("store: list low vitality iteration: %w", err)
	}

	return results, nil
}

// GetReviewDueMemories returns memory records whose review_by date has passed.
// Only returns enabled, non-expired, non-superseded memories.
func (s *Store) GetReviewDueMemories(ctx context.Context) ([]DocRow, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, url, section_path, content, content_hash, source_type, sub_type,
			version, crawled_at, ttl_days, hit_count, last_accessed, review_by
		 FROM records
		 WHERE source_type = ? AND enabled = 1
		   AND review_by IS NOT NULL AND review_by != '' AND review_by < datetime('now')
		   AND (valid_until IS NULL OR valid_until > datetime('now'))
		   AND superseded_by IS NULL
		 ORDER BY review_by ASC
		 LIMIT 50`,
		SourceMemory)
	if err != nil {
		return nil, fmt.Errorf("store: get review due memories: %w", err)
	}
	defer rows.Close()

	var docs []DocRow
	for rows.Next() {
		var d DocRow
		var version sql.NullString
		var reviewBy sql.NullString
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content, &d.ContentHash,
			&d.SourceType, &d.SubType, &version, &d.CrawledAt, &d.TTLDays,
			&d.HitCount, &d.LastAccessed, &reviewBy); err != nil {
			continue
		}
		d.Version = version.String
		d.ReviewBy = reviewBy.String
		docs = append(docs, d)
	}
	return docs, rows.Err()
}

// GetExpiringMemories returns memories with valid_until within the given days from now.
// Only returns enabled, non-superseded memories.
func (s *Store) GetExpiringMemories(ctx context.Context, withinDays int) ([]DocRow, error) {
	if withinDays <= 0 {
		withinDays = 7
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, url, section_path, content, source_type, sub_type, hit_count, valid_until
		 FROM records
		 WHERE source_type = ? AND enabled = 1
		   AND valid_until IS NOT NULL AND valid_until != ''
		   AND valid_until > datetime('now')
		   AND valid_until <= datetime('now', ? || ' days')
		   AND superseded_by IS NULL
		 ORDER BY valid_until ASC
		 LIMIT 50`,
		SourceMemory, fmt.Sprintf("+%d", withinDays))
	if err != nil {
		return nil, fmt.Errorf("store: get expiring memories: %w", err)
	}
	defer rows.Close()

	var docs []DocRow
	for rows.Next() {
		var d DocRow
		var validUntil sql.NullString
		if err := rows.Scan(&d.ID, &d.URL, &d.SectionPath, &d.Content,
			&d.SourceType, &d.SubType, &d.HitCount, &validUntil); err != nil {
			continue
		}
		d.ValidUntil = validUntil.String
		docs = append(docs, d)
	}
	return docs, rows.Err()
}

// SetSupersededBy sets the superseded_by field on a record to point to a newer version.
// Pass newID=0 to clear the superseded_by link (detach from chain).
func (s *Store) SetSupersededBy(ctx context.Context, oldID, newID int64) error {
	var newIDVal any
	if newID > 0 {
		newIDVal = newID
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE records SET superseded_by = ? WHERE id = ? AND source_type = ?`,
		newIDVal, oldID, SourceMemory)
	if err != nil {
		return fmt.Errorf("store: set superseded_by: %w", err)
	}
	return nil
}

// GetVersionChain walks the superseded_by chain starting from the given record ID.
// Returns IDs in order from oldest to newest (excluding startID).
// Stops at maxHops to prevent infinite loops from corrupted data.
func (s *Store) GetVersionChain(ctx context.Context, startID int64, maxHops int) ([]int64, error) {
	if maxHops <= 0 {
		maxHops = 5
	}
	seen := map[int64]bool{startID: true}
	currentID := startID
	var chain []int64

	for i := 0; i < maxHops; i++ {
		var supersededBy sql.NullInt64
		err := s.db.QueryRowContext(ctx,
			`SELECT superseded_by FROM records WHERE id = ?`, currentID).Scan(&supersededBy)
		if err != nil || !supersededBy.Valid || supersededBy.Int64 == 0 {
			break
		}
		nextID := supersededBy.Int64
		if seen[nextID] {
			return chain, fmt.Errorf("store: version chain cycle detected at record %d", nextID)
		}
		seen[nextID] = true
		chain = append(chain, nextID)
		currentID = nextID
	}
	return chain, nil
}

// GetReverseVersionChain walks backwards from a record to find all older versions
// that point to it (or its predecessors) via superseded_by.
// Returns IDs from newest to oldest.
func (s *Store) GetReverseVersionChain(ctx context.Context, newestID int64, maxHops int) ([]int64, error) {
	if maxHops <= 0 {
		maxHops = 5
	}
	seen := map[int64]bool{newestID: true}
	currentID := newestID
	var chain []int64

	for i := 0; i < maxHops; i++ {
		var olderID int64
		err := s.db.QueryRowContext(ctx,
			`SELECT id FROM records WHERE superseded_by = ?`, currentID).Scan(&olderID)
		if err != nil {
			break // no more predecessors
		}
		if seen[olderID] {
			return chain, fmt.Errorf("store: reverse version chain cycle detected at record %d", olderID)
		}
		seen[olderID] = true
		chain = append(chain, olderID)
		currentID = olderID
	}
	return chain, nil
}

// VersionChainInfo holds metadata about a version chain head.
type VersionChainInfo struct {
	HeadID      int64
	SectionPath string
	ChainLength int
}

// GetVersionChainLengths returns records that are heads of version chains (superseded_by IS NULL)
// with chain length > minLength. Used for "high churn" detection in reflect.
func (s *Store) GetVersionChainLengths(ctx context.Context, minLength int) ([]VersionChainInfo, error) {
	// Find all non-superseded memory records that have at least one predecessor.
	rows, err := s.db.QueryContext(ctx,
		`SELECT r.id, r.section_path FROM records r
		 WHERE r.source_type = ? AND r.superseded_by IS NULL
		   AND EXISTS (SELECT 1 FROM records p WHERE p.superseded_by = r.id)`,
		SourceMemory)
	if err != nil {
		return nil, fmt.Errorf("store: get version chain lengths: %w", err)
	}
	defer rows.Close()

	var results []VersionChainInfo

	for rows.Next() {
		var id int64
		var sp string
		if err := rows.Scan(&id, &sp); err != nil {
			continue
		}
		// Walk backwards to count chain length.
		predecessors, _ := s.GetReverseVersionChain(ctx, id, 10)
		chainLen := len(predecessors) + 1 // include head
		if chainLen > minLength {
			results = append(results, VersionChainInfo{HeadID: id, SectionPath: sp, ChainLength: chainLen})
		}
	}
	return results, rows.Err()
}
