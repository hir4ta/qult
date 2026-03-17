package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// KnowledgeRow represents a row in the knowledge_index table.
type KnowledgeRow struct {
	ID            int64
	FilePath      string // relative: decisions/dec-001.md
	ContentHash   string
	Title         string
	Content       string
	SubType       string // decision/pattern/rule/general
	ProjectRemote string
	ProjectPath   string
	ProjectName   string
	Branch        string
	CreatedAt     string
	UpdatedAt     string
	HitCount      int64
	LastAccessed  string
	Enabled       bool
}

// KnowledgeStats holds aggregate statistics about knowledge entries.
type KnowledgeStats struct {
	Total       int64
	BySubType   map[string]int64
	AvgHitCount float64
	TopAccessed []KnowledgeRow
}

// LowVitalityRow extends KnowledgeRow with a computed vitality score.
type LowVitalityRow struct {
	KnowledgeRow
	Vitality float64
}

// ContentHash returns the SHA-256 hex hash of content.
func ContentHash(content string) string {
	h := sha256.Sum256([]byte(content))
	return fmt.Sprintf("%x", h)
}

// UpsertKnowledge inserts or updates a knowledge entry.
// Returns the row ID, whether the content changed, and any error.
func (s *Store) UpsertKnowledge(ctx context.Context, row *KnowledgeRow) (int64, bool, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	if row.CreatedAt == "" {
		row.CreatedAt = now
	}
	row.UpdatedAt = now
	row.ContentHash = ContentHash(row.Content)

	// Check if content unchanged (skip update for performance).
	var existingID int64
	var existingHash string
	err := s.db.QueryRowContext(ctx,
		`SELECT id, content_hash FROM knowledge_index
		 WHERE project_remote = ? AND project_path = ? AND file_path = ?`,
		row.ProjectRemote, row.ProjectPath, row.FilePath,
	).Scan(&existingID, &existingHash)
	if err == nil && existingHash == row.ContentHash {
		row.ID = existingID
		return existingID, false, nil
	}

	// Atomic upsert via INSERT ON CONFLICT DO UPDATE.
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO knowledge_index
		 (file_path, content_hash, title, content, sub_type,
		  project_remote, project_path, project_name, branch,
		  created_at, updated_at, hit_count, last_accessed, enabled)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', 1)
		 ON CONFLICT(project_remote, project_path, file_path) DO UPDATE SET
		  content_hash = excluded.content_hash,
		  title = excluded.title,
		  content = excluded.content,
		  sub_type = excluded.sub_type,
		  project_name = excluded.project_name,
		  branch = excluded.branch,
		  updated_at = excluded.updated_at`,
		row.FilePath, row.ContentHash, row.Title, row.Content, row.SubType,
		row.ProjectRemote, row.ProjectPath, row.ProjectName, row.Branch,
		row.CreatedAt, row.UpdatedAt,
	)
	if err != nil {
		return 0, false, fmt.Errorf("store: upsert knowledge: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, false, fmt.Errorf("store: upsert knowledge last insert id: %w", err)
	}

	// LastInsertId returns the rowid whether inserted or updated in SQLite.
	// For ON CONFLICT DO UPDATE, it returns the existing row's id.
	row.ID = id
	return id, true, nil
}

// DeleteKnowledge removes a knowledge entry by ID.
func (s *Store) DeleteKnowledge(ctx context.Context, id int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin tx: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `DELETE FROM embeddings WHERE source = 'knowledge' AND source_id = ?`, id); err != nil {
		return fmt.Errorf("store: delete knowledge embedding: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM knowledge_index WHERE id = ?`, id); err != nil {
		return fmt.Errorf("store: delete knowledge: %w", err)
	}
	return tx.Commit()
}

// DeleteKnowledgeByProject removes all knowledge entries for a project.
func (s *Store) DeleteKnowledgeByProject(ctx context.Context, projectRemote, projectPath string) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("store: begin tx: %w", err)
	}
	defer tx.Rollback()

	// Delete embeddings first.
	_, err = tx.ExecContext(ctx,
		`DELETE FROM embeddings WHERE source = 'knowledge' AND source_id IN
		 (SELECT id FROM knowledge_index WHERE project_remote = ? AND project_path = ?)`,
		projectRemote, projectPath,
	)
	if err != nil {
		return 0, fmt.Errorf("store: delete project embeddings: %w", err)
	}

	res, err := tx.ExecContext(ctx,
		`DELETE FROM knowledge_index WHERE project_remote = ? AND project_path = ?`,
		projectRemote, projectPath,
	)
	if err != nil {
		return 0, fmt.Errorf("store: delete project knowledge: %w", err)
	}
	n, _ := res.RowsAffected()
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return n, nil
}

// GetKnowledgeByID returns a single knowledge entry.
func (s *Store) GetKnowledgeByID(ctx context.Context, id int64) (*KnowledgeRow, error) {
	row := &KnowledgeRow{}
	err := s.db.QueryRowContext(ctx,
		`SELECT id, file_path, content_hash, title, content, sub_type,
		        project_remote, project_path, project_name, branch,
		        created_at, updated_at, hit_count, last_accessed, enabled
		 FROM knowledge_index WHERE id = ?`, id,
	).Scan(&row.ID, &row.FilePath, &row.ContentHash, &row.Title, &row.Content, &row.SubType,
		&row.ProjectRemote, &row.ProjectPath, &row.ProjectName, &row.Branch,
		&row.CreatedAt, &row.UpdatedAt, &row.HitCount, &row.LastAccessed, &row.Enabled)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("store: knowledge %d not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("store: get knowledge: %w", err)
	}
	return row, nil
}

// GetKnowledgeByIDs returns multiple knowledge entries by ID.
func (s *Store) GetKnowledgeByIDs(ctx context.Context, ids []int64) ([]KnowledgeRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}
	query := `SELECT id, file_path, content_hash, title, content, sub_type,
	                 project_remote, project_path, project_name, branch,
	                 created_at, updated_at, hit_count, last_accessed, enabled
	          FROM knowledge_index WHERE id IN (` + strings.Join(placeholders, ",") + `)`

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("store: get knowledge by IDs: %w", err)
	}
	defer rows.Close()
	return scanKnowledgeRows(rows)
}

// ListKnowledge returns recent enabled knowledge for a specific project.
func (s *Store) ListKnowledge(ctx context.Context, projectRemote, projectPath string, limit int) ([]KnowledgeRow, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, file_path, content_hash, title, content, sub_type,
		        project_remote, project_path, project_name, branch,
		        created_at, updated_at, hit_count, last_accessed, enabled
		 FROM knowledge_index
		 WHERE project_remote = ? AND project_path = ? AND enabled = 1
		 ORDER BY updated_at DESC LIMIT ?`,
		projectRemote, projectPath, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("store: list knowledge: %w", err)
	}
	defer rows.Close()
	return scanKnowledgeRows(rows)
}

// ListAllKnowledge returns all knowledge (including disabled) for a project.
func (s *Store) ListAllKnowledge(ctx context.Context, projectRemote, projectPath string, limit int) ([]KnowledgeRow, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, file_path, content_hash, title, content, sub_type,
		        project_remote, project_path, project_name, branch,
		        created_at, updated_at, hit_count, last_accessed, enabled
		 FROM knowledge_index
		 WHERE project_remote = ? AND project_path = ?
		 ORDER BY updated_at DESC LIMIT ?`,
		projectRemote, projectPath, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("store: list all knowledge: %w", err)
	}
	defer rows.Close()
	return scanKnowledgeRows(rows)
}

// SetKnowledgeEnabled toggles the enabled flag.
func (s *Store) SetKnowledgeEnabled(ctx context.Context, id int64, enabled bool) error {
	val := 0
	if enabled {
		val = 1
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE knowledge_index SET enabled = ? WHERE id = ?`, val, id)
	if err != nil {
		return fmt.Errorf("store: set knowledge enabled: %w", err)
	}
	return nil
}

// IncrementHitCount increments hit_count and updates last_accessed for given IDs.
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
	_, err := s.db.ExecContext(ctx,
		`UPDATE knowledge_index SET hit_count = hit_count + 1, last_accessed = ?
		 WHERE id IN (`+strings.Join(placeholders, ",")+`)`, args...)
	if err != nil {
		return fmt.Errorf("store: increment hit count: %w", err)
	}
	return nil
}

// PromoteSubType promotes a knowledge entry (general→pattern, pattern→rule).
func (s *Store) PromoteSubType(ctx context.Context, id int64, newSubType string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE knowledge_index SET sub_type = ?, updated_at = ? WHERE id = ? AND enabled = 1`,
		newSubType, time.Now().UTC().Format(time.RFC3339), id,
	)
	if err != nil {
		return fmt.Errorf("store: promote sub_type: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("store: promote sub_type: knowledge %d not found or disabled", id)
	}
	return nil
}

// GetPromotionCandidates returns knowledge entries that exceed promotion hit thresholds.
func (s *Store) GetPromotionCandidates(ctx context.Context) ([]KnowledgeRow, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, file_path, content_hash, title, content, sub_type,
		        project_remote, project_path, project_name, branch,
		        created_at, updated_at, hit_count, last_accessed, enabled
		 FROM knowledge_index
		 WHERE enabled = 1
		   AND ((sub_type = 'general' AND hit_count >= 5)
		     OR (sub_type = 'pattern' AND hit_count >= 15))
		 ORDER BY hit_count DESC`)
	if err != nil {
		return nil, fmt.Errorf("store: get promotion candidates: %w", err)
	}
	defer rows.Close()
	return scanKnowledgeRows(rows)
}

// GetKnowledgeStats returns aggregate statistics.
func (s *Store) GetKnowledgeStats(ctx context.Context) (*KnowledgeStats, error) {
	stats := &KnowledgeStats{
		BySubType: make(map[string]int64),
	}

	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*), COALESCE(AVG(hit_count), 0) FROM knowledge_index WHERE enabled = 1`,
	).Scan(&stats.Total, &stats.AvgHitCount)
	if err != nil {
		return nil, fmt.Errorf("store: get knowledge stats: %w", err)
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT sub_type, COUNT(*) FROM knowledge_index WHERE enabled = 1 GROUP BY sub_type`)
	if err != nil {
		return nil, fmt.Errorf("store: get knowledge stats by sub_type: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var st string
		var count int64
		if err := rows.Scan(&st, &count); err != nil {
			return nil, err
		}
		stats.BySubType[st] = count
	}

	topRows, err := s.db.QueryContext(ctx,
		`SELECT id, file_path, content_hash, title, content, sub_type,
		        project_remote, project_path, project_name, branch,
		        created_at, updated_at, hit_count, last_accessed, enabled
		 FROM knowledge_index WHERE enabled = 1
		 ORDER BY hit_count DESC LIMIT 5`)
	if err != nil {
		return nil, fmt.Errorf("store: get top accessed: %w", err)
	}
	defer topRows.Close()
	stats.TopAccessed, err = scanKnowledgeRows(topRows)
	if err != nil {
		return nil, err
	}
	return stats, nil
}

// SearchKnowledgeKeyword performs a LIKE substring search on knowledge.
func (s *Store) SearchKnowledgeKeyword(ctx context.Context, query string, limit int) ([]KnowledgeRow, error) {
	escaped := escapeLIKEContains(query)
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, file_path, content_hash, title, content, sub_type,
		        project_remote, project_path, project_name, branch,
		        created_at, updated_at, hit_count, last_accessed, enabled
		 FROM knowledge_index
		 WHERE enabled = 1 AND (content LIKE ? ESCAPE '\' OR title LIKE ? ESCAPE '\')
		 ORDER BY hit_count DESC LIMIT ?`,
		escaped, escaped, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("store: keyword search: %w", err)
	}
	defer rows.Close()
	return scanKnowledgeRows(rows)
}

// CountKnowledge returns the count of enabled knowledge entries for a project.
func (s *Store) CountKnowledge(ctx context.Context, projectRemote, projectPath string) (int64, error) {
	var count int64
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM knowledge_index
		 WHERE project_remote = ? AND project_path = ? AND enabled = 1`,
		projectRemote, projectPath,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("store: count knowledge: %w", err)
	}
	return count, nil
}

// scanKnowledgeRows scans multiple rows into KnowledgeRow slices.
func scanKnowledgeRows(rows *sql.Rows) ([]KnowledgeRow, error) {
	var result []KnowledgeRow
	for rows.Next() {
		var r KnowledgeRow
		if err := rows.Scan(
			&r.ID, &r.FilePath, &r.ContentHash, &r.Title, &r.Content, &r.SubType,
			&r.ProjectRemote, &r.ProjectPath, &r.ProjectName, &r.Branch,
			&r.CreatedAt, &r.UpdatedAt, &r.HitCount, &r.LastAccessed, &r.Enabled,
		); err != nil {
			return nil, fmt.Errorf("store: scan knowledge row: %w", err)
		}
		result = append(result, r)
	}
	return result, rows.Err()
}

// escapeLIKEContains escapes special LIKE characters and wraps with %.
func escapeLIKEContains(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return "%" + s + "%"
}
