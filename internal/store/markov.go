package store

import (
	"fmt"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
)

// GlobalToolPrediction represents a predicted next tool from cross-session data.
type GlobalToolPrediction struct {
	Tool        string
	Count       int
	SuccessRate float64
}

// MergeToolSequences merges session-local tool bigrams into the global store.
func (s *Store) MergeToolSequences(entries []sessiondb.BigramEntry) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: begin merge sequences tx: %w", err)
	}
	defer tx.Rollback() //nolint: errcheck

	stmt, err := tx.Prepare(
		`INSERT INTO global_tool_sequences (from_tool, to_tool, count, success_count)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(from_tool, to_tool) DO UPDATE SET
		   count = count + excluded.count,
		   success_count = success_count + excluded.success_count`,
	)
	if err != nil {
		return fmt.Errorf("store: prepare merge sequences: %w", err)
	}
	defer stmt.Close()

	for _, e := range entries {
		if _, err := stmt.Exec(e.FromTool, e.ToTool, e.Count, e.SuccessCount); err != nil {
			return fmt.Errorf("store: merge sequence %s→%s: %w", e.FromTool, e.ToTool, err)
		}
	}

	return tx.Commit()
}

// MergeToolTrigrams merges session-local tool trigrams into the global store.
func (s *Store) MergeToolTrigrams(entries []sessiondb.TrigramEntry) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: begin merge trigrams tx: %w", err)
	}
	defer tx.Rollback() //nolint: errcheck

	stmt, err := tx.Prepare(
		`INSERT INTO global_tool_trigrams (tool1, tool2, tool3, count, success_count)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(tool1, tool2, tool3) DO UPDATE SET
		   count = count + excluded.count,
		   success_count = success_count + excluded.success_count`,
	)
	if err != nil {
		return fmt.Errorf("store: prepare merge trigrams: %w", err)
	}
	defer stmt.Close()

	for _, e := range entries {
		if _, err := stmt.Exec(e.Tool1, e.Tool2, e.Tool3, e.Count, e.SuccessCount); err != nil {
			return fmt.Errorf("store: merge trigram %s→%s→%s: %w", e.Tool1, e.Tool2, e.Tool3, err)
		}
	}

	return tx.Commit()
}

// PredictNextToolGlobal returns the most likely next tools from global data.
// Results are ranked by count with success rate.
func (s *Store) PredictNextToolGlobal(fromTool string, limit int) ([]GlobalToolPrediction, error) {
	if fromTool == "" || limit <= 0 {
		return nil, nil
	}

	rows, err := s.db.Query(
		`SELECT to_tool, count, success_count FROM global_tool_sequences
		 WHERE from_tool = ? ORDER BY count DESC LIMIT ?`,
		fromTool, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("store: predict next tool global: %w", err)
	}
	defer rows.Close()

	var predictions []GlobalToolPrediction
	for rows.Next() {
		var p GlobalToolPrediction
		var successCount int
		if err := rows.Scan(&p.Tool, &p.Count, &successCount); err != nil {
			continue
		}
		if p.Count > 0 {
			p.SuccessRate = float64(successCount) / float64(p.Count)
		}
		predictions = append(predictions, p)
	}
	return predictions, rows.Err()
}

// PredictFromTrigramGlobal returns the most likely next tools given a tool pair.
func (s *Store) PredictFromTrigramGlobal(tool1, tool2 string, limit int) ([]GlobalToolPrediction, error) {
	if tool1 == "" || tool2 == "" || limit <= 0 {
		return nil, nil
	}

	rows, err := s.db.Query(
		`SELECT tool3, count, success_count FROM global_tool_trigrams
		 WHERE tool1 = ? AND tool2 = ? ORDER BY count DESC LIMIT ?`,
		tool1, tool2, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("store: predict from trigram global: %w", err)
	}
	defer rows.Close()

	var predictions []GlobalToolPrediction
	for rows.Next() {
		var p GlobalToolPrediction
		var successCount int
		if err := rows.Scan(&p.Tool, &p.Count, &successCount); err != nil {
			continue
		}
		if p.Count > 0 {
			p.SuccessRate = float64(successCount) / float64(p.Count)
		}
		predictions = append(predictions, p)
	}
	return predictions, rows.Err()
}
