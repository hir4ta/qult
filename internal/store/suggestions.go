package store

import (
	"fmt"
	"math"
	"time"
)

// InsertSuggestionOutcome records a nudge delivery for effectiveness tracking.
func (s *Store) InsertSuggestionOutcome(sessionID, pattern, suggestion string) (int64, error) {
	res, err := s.db.Exec(
		`INSERT INTO suggestion_outcomes (session_id, pattern, suggestion) VALUES (?, ?, ?)`,
		sessionID, pattern, suggestion,
	)
	if err != nil {
		return 0, fmt.Errorf("store: insert suggestion outcome: %w", err)
	}
	id, _ := res.LastInsertId()
	return id, nil
}

// ResolveSuggestion marks a suggestion outcome as resolved (acted upon).
func (s *Store) ResolveSuggestion(id int64) error {
	_, err := s.db.Exec(
		`UPDATE suggestion_outcomes SET resolved = 1 WHERE id = ? AND resolved = 0`, id,
	)
	if err != nil {
		return fmt.Errorf("store: resolve suggestion: %w", err)
	}
	return nil
}

// ResolveLastSuggestion marks the most recent unresolved outcome for a session+pattern as resolved.
func (s *Store) ResolveLastSuggestion(sessionID, pattern string) error {
	_, err := s.db.Exec(
		`UPDATE suggestion_outcomes SET resolved = 1
		 WHERE id = (
		     SELECT id FROM suggestion_outcomes
		     WHERE session_id = ? AND pattern = ? AND resolved = 0
		     ORDER BY id DESC LIMIT 1
		 )`,
		sessionID, pattern,
	)
	if err != nil {
		return fmt.Errorf("store: resolve last suggestion: %w", err)
	}
	return nil
}

// PatternEffectiveness returns delivery and resolution counts for a nudge pattern.
func (s *Store) PatternEffectiveness(pattern string) (delivered, resolved int, err error) {
	err = s.db.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(resolved), 0)
		 FROM suggestion_outcomes WHERE pattern = ?`, pattern,
	).Scan(&delivered, &resolved)
	if err != nil {
		return 0, 0, fmt.Errorf("store: pattern effectiveness: %w", err)
	}
	return delivered, resolved, nil
}

// ShouldSuppressPattern returns true if a pattern has been delivered enough times
// with a consistently very low resolution rate, as measured by decayed effectiveness.
// Uses a 5% threshold as a safety net; Thompson Sampling handles the 5-50% range.
func (s *Store) ShouldSuppressPattern(pattern string) bool {
	delivered, resolved, err := s.DecayedPatternEffectiveness(pattern)
	if err != nil || delivered < 15 {
		return false
	}
	rate := resolved / delivered
	return rate < 0.05
}

// DecayedPatternEffectiveness returns time-weighted delivery and resolution counts.
// Recent outcomes (last 30 days) count fully; older outcomes are exponentially
// decayed with a half-life of 30 days. Returns float64 counts to preserve decay precision.
func (s *Store) DecayedPatternEffectiveness(pattern string) (delivered, resolved float64, err error) {
	rows, err := s.db.Query(
		`SELECT resolved, delivered_at FROM suggestion_outcomes WHERE pattern = ?`,
		pattern,
	)
	if err != nil {
		return 0, 0, fmt.Errorf("store: decayed pattern effectiveness: %w", err)
	}
	defer rows.Close()

	now := time.Now()
	halfLife := 30 * 24 * time.Hour
	lambda := math.Ln2 / halfLife.Seconds()

	for rows.Next() {
		var resolvedInt int
		var deliveredAt string
		if err := rows.Scan(&resolvedInt, &deliveredAt); err != nil {
			continue
		}
		ts, err := time.Parse("2006-01-02 15:04:05", deliveredAt)
		if err != nil {
			continue
		}
		age := now.Sub(ts).Seconds()
		if age < 0 {
			age = 0
		}
		weight := math.Exp(-lambda * age)
		delivered += weight
		if resolvedInt == 1 {
			resolved += weight
		}
	}
	return delivered, resolved, rows.Err()
}
